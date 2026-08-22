import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { ArrowLeft, AlertCircle, Repeat, Clock, AlertTriangle, CalendarClock, Check, X } from 'lucide-react';
import CalendarGrid from '@/components/calendar/CalendarGrid';
import TimeSlotPicker from '@/components/calendar/TimeSlotPicker';
import IntakeForm from '@/components/booking/IntakeForm';
import type { IntakeFormData } from '@/components/booking/IntakeForm';
import BookingConfirmation from '@/components/booking/BookingConfirmation';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import Select from '@/components/ui/Select';
import Input from '@/components/ui/Input';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import { supabase } from '@/lib/supabase';
import { useAvailability } from '@/hooks/useAvailability';
import { useBookings } from '@/hooks/useBookings';
import { useSettings } from '@/hooks/useSettings';
import { useRecurringLinks } from '@/hooks/useRecurringLinks';
import { generateTimeSlots, formatDate, formatDisplayDate, formatTime, addDays, detectTimezone, getTimezoneOptions, classNames, timeToMinutes, hasAvailability, convertTimeSlot, convertTimeSlotWithDate } from '@/lib/utils';
import { triggerRecurringConfirmationEmail } from '@/lib/bookingEmails';
import type { Booking, RecurringLink, MeetingType, BookingStep } from '@/lib/types';

type ConflictResolution = 'pending' | 'reschedule' | 'skip';

interface SessionConflict {
  date: string;
  index: number;
  hasConflict: boolean;
  resolution: ConflictResolution;
  rescheduleDate?: string;
  rescheduleTime?: string;
}

export default function RecurringBookingPage() {
  const { token } = useParams<{ token: string }>();
  const { fetchLinkByToken, markLinkAsUsed } = useRecurringLinks();
  const { rules, overrides, loading: availLoading } = useAvailability();
  const { createBooking, fetchBookingsForDate } = useBookings({ autoFetch: false });
  const { settings, loading: settingsLoading } = useSettings();

  const [link, setLink] = useState<RecurringLink | null>(null);
  const [meetingType, setMeetingType] = useState<MeetingType | null>(null);
  const [linkLoading, setLinkLoading] = useState(true);
  const [linkError, setLinkError] = useState(false);

  const [step, setStep] = useState<BookingStep | 'recurrence' | 'conflicts'>('calendar');
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [slots, setSlots] = useState<string[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmedBooking, setConfirmedBooking] = useState<Booking | null>(null);
  const [clientTimezone, setClientTimezone] = useState(detectTimezone);
  const [conflictError, setConflictError] = useState('');
  const [linkExpired, setLinkExpired] = useState(false);

  const [frequency, setFrequency] = useState('weekly');
  const [occurrences, setOccurrences] = useState('4');
  const [endDate, setEndDate] = useState('');

  const [sessionConflicts, setSessionConflicts] = useState<SessionConflict[]>([]);
  const [conflictChecking, setConflictChecking] = useState(false);
  const [rescheduleSlots, setRescheduleSlots] = useState<Record<number, string[]>>({});
  const [rescheduleSlotsLoading, setRescheduleSlotsLoading] = useState<Record<number, boolean>>({});

  const now = new Date();
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth());

  const windowDays = settings?.booking_window_days || 90;
  const maxDate = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + windowDays);
    return d;
  }, [windowDays]);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const data = await fetchLinkByToken(token);
        if (!data) {
          setLinkError(true);
        } else if (data.is_used) {
          setLinkExpired(true);
        } else if (data.expires_at && new Date(data.expires_at) < new Date()) {
          setLinkExpired(true);
        } else {
          setLink(data);
          if (data.frequency) setFrequency(data.frequency);
          if (data.occurrences) setOccurrences(data.occurrences.toString());
          if (data.end_date) setEndDate(data.end_date);
          if (data.meeting_type_id) {
            const { data: mt } = await supabase
              .from('meeting_types')
              .select('*')
              .eq('id', data.meeting_type_id)
              .maybeSingle();
            if (mt) setMeetingType(mt);
          }
        }
      } catch {
        setLinkError(true);
      } finally {
        setLinkLoading(false);
      }
    })();
  }, [token, fetchLinkByToken]);

  const durationMinutes = meetingType?.duration_minutes || settings?.default_meeting_length || 30;
  const bufferMinutes = meetingType?.buffer_minutes ?? settings?.buffer_minutes ?? 0;
  const leadHours = settings?.booking_lead_hours || 2;
  const slotIncrement = settings?.slot_increment_minutes ?? 15;

  const isFlexible = link?.scheduling_mode === 'flexible';

  const adminTimezone = settings?.timezone || 'America/New_York';

  // Allowed days filtering
  const allowedDays = link?.allowed_days || null;
  const allowedTimeStart = link?.allowed_time_start || null;
  const allowedTimeEnd = link?.allowed_time_end || null;

  const loadSlots = useCallback(async (dateStr: string) => {
    setSlotsLoading(true);
    const existing = await fetchBookingsForDate(dateStr);
    const date = new Date(dateStr + 'T00:00:00');
    let available = generateTimeSlots(date, rules, overrides, existing, durationMinutes, leadHours, bufferMinutes, slotIncrement);

    // Filter by allowed time range if set
    if (allowedTimeStart && allowedTimeEnd) {
      const aStart = timeToMinutes(allowedTimeStart);
      const aEnd = timeToMinutes(allowedTimeEnd);
      available = available.filter(s => {
        const sMin = timeToMinutes(s);
        return sMin >= aStart && sMin + durationMinutes <= aEnd;
      });
    }

    setSlots(available);
    setSlotsLoading(false);
  }, [rules, overrides, settings, fetchBookingsForDate, durationMinutes, allowedTimeStart, allowedTimeEnd, leadHours, bufferMinutes, slotIncrement]);

  // Check if a date is allowed based on allowed_days
  const isDateAllowed = useCallback((dateStr: string) => {
    if (!allowedDays || allowedDays.length === 0) return true;
    const date = new Date(dateStr + 'T00:00:00');
    return allowedDays.includes(date.getDay());
  }, [allowedDays]);

  const handleDateSelect = (dateStr: string) => {
    if (!isDateAllowed(dateStr)) return;
    setSelectedDate(dateStr);
    setSelectedSlot(null);
    setStep('time');
    loadSlots(dateStr);
  };

  const displaySlots = useMemo(() =>
    slots.map(s => convertTimeSlot(s, selectedDate || '', adminTimezone, clientTimezone)),
    [slots, selectedDate, adminTimezone, clientTimezone]
  );

  const handleSlotSelect = (slot: string) => {
    const adminSlot = convertTimeSlotWithDate(slot, selectedDate || '', clientTimezone, adminTimezone);
    setSelectedDate(adminSlot.date);
    setSelectedSlot(adminSlot.time);
    setStep('recurrence');
  };

  const recurringDates = useMemo(() => {
    if (!selectedDate || !link) return [];
    const dates: string[] = [selectedDate];
    const start = new Date(selectedDate + 'T00:00:00');
    const intervalDays = frequency === 'daily' ? 1 : frequency === 'weekly' ? 7 : frequency === 'biweekly' ? 14 : 30;
    const maxOccurrences = parseInt(occurrences) || 0;

    if (link.is_ongoing) {
      for (let i = 1; ; i++) {
        const next = addDays(start, intervalDays * i);
        if (next > maxDate) break;
        dates.push(formatDate(next));
      }
      return dates;
    }

    for (let i = 1; ; i++) {
      const next = addDays(start, intervalDays * i);
      if (next > maxDate) break;
      const nextStr = formatDate(next);
      if (endDate && nextStr > endDate) break;
      if (maxOccurrences > 0 && dates.length >= maxOccurrences) break;
      dates.push(nextStr);
    }
    return dates;
  }, [selectedDate, frequency, occurrences, endDate, maxDate, link]);

  // Check all sessions for conflicts
  const checkConflicts = useCallback(async () => {
    setConflictChecking(true);
    setConflictError('');
    const conflicts: SessionConflict[] = [];

    for (let i = 0; i < recurringDates.length; i++) {
      const date = recurringDates[i];
      const dateObj = new Date(date + 'T00:00:00');
      const dayOfWeek = dateObj.getDay();

      // Check allowed days
      let isConflict = false;

      if (allowedDays && allowedDays.length > 0 && !allowedDays.includes(dayOfWeek)) {
        isConflict = true;
      }

      // Check availability
      if (!isConflict) {
        const existing = await fetchBookingsForDate(date);
        const available = generateTimeSlots(dateObj, rules, overrides, existing, durationMinutes, leadHours, bufferMinutes, slotIncrement);

        // Filter by allowed time range
        let filtered = available;
        if (allowedTimeStart && allowedTimeEnd) {
          const aStart = timeToMinutes(allowedTimeStart);
          const aEnd = timeToMinutes(allowedTimeEnd);
          filtered = available.filter(s => {
            const sMin = timeToMinutes(s);
            return sMin >= aStart && sMin + durationMinutes <= aEnd;
          });
        }

        if (!filtered.includes(selectedSlot!)) {
          // Check if the slot is outside availability
          if (!hasAvailability(dateObj, rules, overrides)) {
            isConflict = true;
          } else {
            // Check if slot conflicts with existing booking
            const startMin = timeToMinutes(selectedSlot!);
            const endMin = startMin + durationMinutes;
            const hasBookingConflict = existing.some(b => {
              const bStart = timeToMinutes(b.start_time);
              const bEnd = timeToMinutes(b.end_time);
              return startMin < bEnd + bufferMinutes && endMin + bufferMinutes > bStart;
            });
            if (hasBookingConflict) isConflict = true;
          }
        }
      }

      conflicts.push({
        date,
        index: i,
        hasConflict: isConflict,
        resolution: 'pending',
      });
    }

    setSessionConflicts(conflicts);
    setConflictChecking(false);

    // If flexible mode and there are conflicts, go to conflicts step
    if (isFlexible && conflicts.some(c => c.hasConflict)) {
      setStep('conflicts');
    } else if (!isFlexible && conflicts.some(c => c.hasConflict)) {
      // Strict mode: don't proceed, show error
      setStep('recurrence');
      setConflictError('This start date would result in sessions with scheduling conflicts. Please choose a different start date.');
    } else {
      setStep('form');
    }
  }, [recurringDates, selectedSlot, allowedDays, allowedTimeStart, allowedTimeEnd, fetchBookingsForDate, rules, overrides, durationMinutes, leadHours, bufferMinutes, slotIncrement, isFlexible]);

  const loadRescheduleSlots = useCallback(async (conflictIndex: number, dateStr: string) => {
    setRescheduleSlotsLoading(prev => ({ ...prev, [conflictIndex]: true }));
    const existing = await fetchBookingsForDate(dateStr);
    const dateObj = new Date(dateStr + 'T00:00:00');
    let available = generateTimeSlots(dateObj, rules, overrides, existing, durationMinutes, leadHours, bufferMinutes, slotIncrement);

    if (allowedTimeStart && allowedTimeEnd) {
      const aStart = timeToMinutes(allowedTimeStart);
      const aEnd = timeToMinutes(allowedTimeEnd);
      available = available.filter(s => {
        const sMin = timeToMinutes(s);
        return sMin >= aStart && sMin + durationMinutes <= aEnd;
      });
    }

    setRescheduleSlots(prev => ({ ...prev, [conflictIndex]: available }));
    setRescheduleSlotsLoading(prev => ({ ...prev, [conflictIndex]: false }));
  }, [fetchBookingsForDate, rules, overrides, durationMinutes, leadHours, bufferMinutes, slotIncrement, allowedTimeStart, allowedTimeEnd]);

  const handleConflictResolution = (index: number, resolution: ConflictResolution) => {
    setSessionConflicts(prev => prev.map(c =>
      c.index === index ? { ...c, resolution } : c
    ));
  };

  const handleRescheduleDateChange = (index: number, dateStr: string) => {
    setSessionConflicts(prev => prev.map(c =>
      c.index === index ? { ...c, rescheduleDate: dateStr, rescheduleTime: undefined } : c
    ));
    if (dateStr) loadRescheduleSlots(index, dateStr);
  };

  const handleRescheduleTimeChange = (index: number, timeStr: string) => {
    setSessionConflicts(prev => prev.map(c =>
      c.index === index ? { ...c, rescheduleTime: timeStr } : c
    ));
  };

  const validateConflictsResolved = (): boolean => {
    const unresolved = sessionConflicts.filter(c => c.hasConflict && c.resolution === 'pending');
    if (unresolved.length > 0) {
      setConflictError(`Please resolve all ${unresolved.length} conflicted session${unresolved.length !== 1 ? 's' : ''} before continuing.`);
      return false;
    }
    const needsRescheduleTime = sessionConflicts.filter(c => c.hasConflict && c.resolution === 'reschedule' && !c.rescheduleTime);
    if (needsRescheduleTime.length > 0) {
      setConflictError(`Please select a new time for ${needsRescheduleTime.length} session${needsRescheduleTime.length !== 1 ? 's' : ''} you chose to reschedule.`);
      return false;
    }
    setConflictError('');
    return true;
  };

  const handleContinueFromConflicts = () => {
    if (!validateConflictsResolved()) return;
    setStep('form');
  };

  // Build the final list of sessions to book
  const finalSessions = useMemo(() => {
    return sessionConflicts
      .filter(c => !(c.hasConflict && c.resolution === 'skip'))
      .map(c => {
        if (c.hasConflict && c.resolution === 'reschedule' && c.rescheduleDate && c.rescheduleTime) {
          return { date: c.rescheduleDate, time: c.rescheduleTime };
        }
        return { date: c.date, time: selectedSlot! };
      });
  }, [sessionConflicts, selectedSlot]);

  const handleSubmit = async (formData: IntakeFormData) => {
    if (!selectedDate || !selectedSlot || !link) return;
    setSubmitting(true);
    setConflictError('');

    const groupId = crypto.randomUUID();
    const sessionsToBook = sessionConflicts.length > 0 ? finalSessions : recurringDates.map(d => ({ date: d, time: selectedSlot }));

    try {
      let firstBooking: Booking | null = null;
      const allBookings: Booking[] = [];
      for (const session of sessionsToBook) {
        const booking = await createBooking({
          first_name: formData.firstName,
          last_name: formData.lastName,
          client_email: formData.email,
          client_phone: formData.phone || undefined,
          is_existing_client: formData.isExistingClient ?? undefined,
          guests: formData.guests,
          date: session.date,
          start_time: session.time,
          duration_minutes: durationMinutes,
          client_notes: formData.clientNotes || undefined,
          notes_to_client: link.notes_to_client || undefined,
          source: 'recurring_link',
          recurring_link_id: link.id,
          recurrence_group_id: groupId,
          client_timezone: clientTimezone,
          meeting_type_id: meetingType?.id || undefined,
        });
        if (!firstBooking) firstBooking = booking;
        allBookings.push(booking);
      }
      setConfirmedBooking(firstBooking);
      setStep('confirm');
      triggerRecurringConfirmationEmail(allBookings.map(b => b.id));
      if (link) await markLinkAsUsed(link.id);
    } catch (err) {
      console.error(err);
      alert('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleNavigate = (dir: -1 | 1) => {
    let newMonth = viewMonth + dir;
    let newYear = viewYear;
    if (newMonth < 0) { newMonth = 11; newYear--; }
    if (newMonth > 11) { newMonth = 0; newYear++; }
    setViewMonth(newMonth);
    setViewYear(newYear);
  };

  const canGoBack = viewYear > now.getFullYear() || (viewYear === now.getFullYear() && viewMonth > now.getMonth());
  const canGoForward = new Date(viewYear, viewMonth + 1, 1) <= maxDate;

  if (linkLoading || availLoading || settingsLoading) {
    return (
      <div className="flex justify-center py-20">
        <LoadingSpinner size="lg" message="Loading booking page..." />
      </div>
    );
  }

  if (linkError || !link) {
    return (
      <Card className="text-center py-16 max-w-lg mx-auto">
        <AlertCircle className="w-12 h-12 text-red-300 mx-auto mb-4" />
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Link Not Found</h2>
        <p className="text-gray-500 mb-6">This booking link is no longer active or does not exist.</p>
      </Card>
    );
  }

  if (linkExpired) {
    return (
      <Card className="text-center py-16 max-w-lg mx-auto">
        <AlertCircle className="w-12 h-12 text-amber-300 mx-auto mb-4" />
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Link No Longer Available</h2>
        <p className="text-gray-500 mb-6">This booking link has already been used or has expired. Please contact us to schedule your appointment.</p>
      </Card>
    );
  }

  const stepOrder: (BookingStep | 'recurrence' | 'conflicts')[] = ['calendar', 'time', 'recurrence', ...(isFlexible ? ['conflicts' as const] : []), 'form'];

  const conflictedCount = sessionConflicts.filter(c => c.hasConflict).length;

  return (
    <div className="max-w-lg mx-auto">
      <div className="flex items-center gap-2 mb-6 text-jungo-green-600">
        <Repeat className="w-5 h-5" />
        <span className="text-sm font-medium">Recurring Booking for {link.client_name}</span>
      </div>

      {step !== 'calendar' && step !== 'confirm' && (
        <button
          onClick={() => {
            if (step === 'form') setStep(isFlexible && conflictedCount > 0 ? 'conflicts' : 'recurrence');
            else if (step === 'conflicts') setStep('recurrence');
            else if (step === 'recurrence') { setStep('time'); setSelectedSlot(null); }
            else if (step === 'time') { setStep('calendar'); setSelectedDate(null); }
          }}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 mb-4 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
      )}

      {step !== 'confirm' && (
        <div className="flex items-center gap-2 mb-8">
          {stepOrder.map((s) => (
            <div key={s} className="flex items-center gap-2 flex-1">
              <div className={classNames(
                'h-1 flex-1 rounded-full transition-colors duration-300',
                stepOrder.indexOf(s) <= stepOrder.indexOf(step) ? 'bg-jungo-green-500' : 'bg-gray-200'
              )} />
            </div>
          ))}
        </div>
      )}

      <Card padding="lg">
        {step === 'calendar' && (
          <>
            <h2 className="text-xl font-bold text-gray-900 mb-1">
              {meetingType?.name || settings?.meeting_name || 'Schedule a Recurring Meeting'}
            </h2>
            {meetingType?.description && (
              <p className="text-sm text-gray-500 mb-4">{meetingType.description}</p>
            )}
            <div className="flex items-center gap-2 mb-6 text-sm text-gray-600">
              <Clock className="w-4 h-4 text-jungo-green-500" />
              <span>{durationMinutes} minutes</span>
            </div>

            <div className="mb-6">
              <Select
                label="Timezone"
                value={clientTimezone}
                onChange={e => setClientTimezone(e.target.value)}
                options={getTimezoneOptions()}
              />
            </div>

            {allowedDays && allowedDays.length > 0 && (
              <div className="mb-4 bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-700">
                <p className="font-medium">Available Days</p>
                <p className="text-xs mt-0.5">You can only start on: {allowedDays.map(d => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]).join(', ')}</p>
              </div>
            )}

            <h3 className="text-lg font-semibold text-gray-900 mb-4">Select Start Date</h3>
            <p className="text-sm text-gray-500 mb-6">Choose when your recurring meetings begin.</p>
            <CalendarGrid
              year={viewYear}
              month={viewMonth}
              selectedDate={selectedDate}
              onSelectDate={handleDateSelect}
              onNavigate={handleNavigate}
              canGoBack={canGoBack}
              canGoForward={canGoForward}
              rules={rules}
              overrides={overrides}
              maxDate={maxDate}
              allowedDays={allowedDays}
            />
          </>
        )}

        {step === 'time' && selectedDate && (
          <TimeSlotPicker
            date={selectedDate}
            slots={displaySlots}
            selectedSlot={selectedSlot ? convertTimeSlot(selectedSlot, selectedDate, adminTimezone, clientTimezone) : null}
            onSelectSlot={handleSlotSelect}
            loading={slotsLoading}
            timezone={clientTimezone}
          />
        )}

        {step === 'recurrence' && selectedDate && selectedSlot && (
          <div className="animate-slide-up space-y-5">
            <h3 className="text-lg font-semibold text-gray-900">Recurrence Details</h3>

            {(link.allow_client_frequency || !link.frequency) && (
              <Select
                label="Frequency"
                value={frequency}
                onChange={e => setFrequency(e.target.value)}
                options={[
                  { value: 'daily', label: 'Daily' },
                  { value: 'weekly', label: 'Weekly' },
                  { value: 'biweekly', label: 'Every 2 weeks' },
                  { value: 'monthly', label: 'Monthly' },
                ]}
              />
            )}

            {link.is_ongoing ? (
              <div className="bg-jungo-green-50 border border-jungo-green-200 rounded-lg p-3 text-sm text-jungo-green-700">
                This is an ongoing recurring series with no end date. Sessions will continue until you stop booking.
              </div>
            ) : (link.allow_client_end_date || (!link.occurrences && !link.end_date)) && (
              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="Number of Sessions"
                  type="number"
                  min="2"
                  max="365"
                  value={occurrences}
                  onChange={e => setOccurrences(e.target.value)}
                />
                <Input
                  label="Or End By Date"
                  type="date"
                  value={endDate}
                  onChange={e => setEndDate(e.target.value)}
                />
              </div>
            )}

            <div className="bg-gray-50 rounded-lg p-4 border">
              <p className="text-sm font-medium text-gray-700 mb-2">
                Schedule Preview ({recurringDates.length} sessions)
                {frequency === 'daily' && recurringDates.length > 20 && (
                  <span className="text-xs text-gray-400 ml-2">
                    ({recurringDates.length} daily sessions will be created)
                  </span>
                )}
              </p>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {recurringDates.map((d, i) => (
                  <p key={d} className="text-sm text-gray-600">
                    <span className="text-gray-400 mr-2">#{i + 1}</span>
                    {formatDisplayDate(d)} at {formatTime(convertTimeSlot(selectedSlot, d, adminTimezone, clientTimezone))}
                  </p>
                ))}
              </div>
            </div>

            {conflictError && (
              <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg p-3">
                <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
                <p className="text-sm text-red-700">{conflictError}</p>
              </div>
            )}

            <Button
              className="w-full"
              size="lg"
              onClick={checkConflicts}
              loading={conflictChecking}
              icon={<CalendarClock className="w-5 h-5" />}
            >
              {conflictChecking ? 'Checking for conflicts...' : 'Check Availability & Continue'}
            </Button>
          </div>
        )}

        {step === 'conflicts' && selectedDate && selectedSlot && (
          <div className="animate-slide-up space-y-5">
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Resolve Conflicts</h3>
              <p className="text-sm text-gray-500 mt-1">
                {conflictedCount} of {recurringDates.length} sessions have scheduling conflicts. For each, choose to reschedule or skip.
              </p>
            </div>

            {conflictError && (
              <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg p-3">
                <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
                <p className="text-sm text-red-700">{conflictError}</p>
              </div>
            )}

            <div className="space-y-3 max-h-96 overflow-y-auto">
              {sessionConflicts.map((conflict) => (
                <div
                  key={conflict.index}
                  className={`rounded-lg border p-3 ${
                    conflict.hasConflict
                      ? 'border-amber-300 bg-amber-50'
                      : 'border-gray-200 bg-gray-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-400">#{conflict.index + 1}</span>
                      <span className="text-sm text-gray-700">
                        {formatDisplayDate(conflict.date)} at {formatTime(convertTimeSlot(selectedSlot, conflict.date, adminTimezone, clientTimezone))}
                      </span>
                    </div>
                    {conflict.hasConflict ? (
                      <span className="flex items-center gap-1 text-xs text-amber-600 font-medium">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        Conflict
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-xs text-jungo-green-600 font-medium">
                        <Check className="w-3.5 h-3.5" />
                        Available
                      </span>
                    )}
                  </div>

                  {conflict.hasConflict && (
                    <div className="space-y-2">
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleConflictResolution(conflict.index, 'reschedule')}
                          className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                            conflict.resolution === 'reschedule'
                              ? 'border-jungo-green-500 bg-jungo-green-500 text-white'
                              : 'border-gray-200 text-gray-600 hover:bg-gray-100'
                          }`}
                        >
                          Reschedule
                        </button>
                        <button
                          onClick={() => handleConflictResolution(conflict.index, 'skip')}
                          className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                            conflict.resolution === 'skip'
                              ? 'border-gray-400 bg-gray-400 text-white'
                              : 'border-gray-200 text-gray-600 hover:bg-gray-100'
                          }`}
                        >
                          Skip
                        </button>
                      </div>

                      {conflict.resolution === 'reschedule' && (
                        <div className="space-y-2 pt-2 border-t border-amber-200">
                          <Input
                            label="New Date"
                            type="date"
                            value={conflict.rescheduleDate || ''}
                            onChange={e => handleRescheduleDateChange(conflict.index, e.target.value)}
                          />
                          {conflict.rescheduleDate && (
                            <>
                              {rescheduleSlotsLoading[conflict.index] ? (
                                <p className="text-xs text-gray-400">Loading available times...</p>
                              ) : (
                                <Select
                                  label="New Time"
                                  value={conflict.rescheduleTime || ''}
                                  onChange={e => handleRescheduleTimeChange(conflict.index, e.target.value)}
                                  options={[
                                    { value: '', label: 'Select...' },
                                    ...(rescheduleSlots[conflict.index] || []).map(s => ({
                                      value: s,
                                      label: formatTime(s),
                                    })),
                                  ]}
                                />
                              )}
                              {conflict.rescheduleDate && !rescheduleSlotsLoading[conflict.index] &&
                                (rescheduleSlots[conflict.index] || []).length === 0 && (
                                <p className="text-xs text-amber-600">No available times on this date. Try another date or skip this session.</p>
                              )}
                            </>
                          )}
                        </div>
                      )}

                      {conflict.resolution === 'skip' && (
                        <div className="flex items-center gap-1.5 text-xs text-gray-500 pt-1">
                          <X className="w-3.5 h-3.5" />
                          This session will be skipped (no booking created).
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="bg-gray-50 rounded-lg p-3 text-sm text-gray-600">
              <p className="font-medium">{finalSessions.length} sessions will be booked.</p>
              {conflictedCount > 0 && (
                <p className="text-xs text-gray-400 mt-0.5">
                  {sessionConflicts.filter(c => c.hasConflict && c.resolution === 'skip').length} skipped,
                  {' '}{sessionConflicts.filter(c => c.hasConflict && c.resolution === 'reschedule').length} rescheduled
                </p>
              )}
            </div>

            <Button className="w-full" size="lg" onClick={handleContinueFromConflicts}>
              Continue to Details
            </Button>
          </div>
        )}

        {step === 'form' && selectedDate && selectedSlot && (
          <IntakeForm
            date={selectedDate}
            time={convertTimeSlot(selectedSlot, selectedDate, adminTimezone, clientTimezone)}
            durationMinutes={durationMinutes}
            onSubmit={handleSubmit}
            loading={submitting}
            prefillName={link.client_name}
            prefillEmail={link.client_email}
          />
        )}

        {step === 'confirm' && confirmedBooking && (
          <div className="animate-scale-in text-center">
            <BookingConfirmation
              booking={confirmedBooking}
              onBookAnother={() => {
                setStep('calendar');
                setSelectedDate(null);
                setSelectedSlot(null);
                setConfirmedBooking(null);
                setSessionConflicts([]);
              }}
            />
            <p className="text-sm text-gray-500 mt-4">
              {sessionConflicts.length > 0 ? finalSessions.length : recurringDates.length} sessions have been booked.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
