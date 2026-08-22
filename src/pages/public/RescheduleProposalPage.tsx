import { useState, useEffect, useCallback } from 'react';
import { CalendarClock, Check, AlertCircle, Clock, Mail } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { useRescheduleProposals } from '@/hooks/useRescheduleProposals';
import { useBookings } from '@/hooks/useBookings';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import Badge from '@/components/ui/Badge';
import { formatTime, formatDisplayDate } from '@/lib/utils';
import type { RescheduleProposalWithSlots } from '@/hooks/useRescheduleProposals';
import type { Booking } from '@/lib/types';

export default function RescheduleProposalPage() {
  const { token } = useParams<{ token: string }>();
  const { fetchByToken, claimSlot } = useRescheduleProposals();
  const { rescheduleBooking } = useBookings({ autoFetch: false });

  const [proposal, setProposal] = useState<RescheduleProposalWithSlots | null>(null);
  const [booking, setBooking] = useState<Booking | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const data = await fetchByToken(token);
        if (!data) {
          setError(true);
          return;
        }
        setProposal(data);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [token, fetchByToken]);

  const handleConfirm = useCallback(async () => {
    if (!proposal || !selectedSlotId || !booking) return;
    setConfirming(true);
    setActionError(null);
    try {
      const slot = proposal.slots.find(s => s.id === selectedSlotId);
      if (!slot) return;

      await claimSlot(proposal.id, selectedSlotId);

      await rescheduleBooking(
        booking.id,
        slot.date,
        slot.start_time,
        booking.duration_minutes,
        true
      );

      setConfirmed(true);
    } catch (err) {
      setActionError('Could not confirm this reschedule. The slot may have already been claimed. Please try another time or contact us.');
      setSelectedSlotId(null);
    } finally {
      setConfirming(false);
    }
  }, [proposal, selectedSlotId, booking, claimSlot, rescheduleBooking]);

  if (loading) {
    return <div className="flex justify-center py-20"><LoadingSpinner size="lg" /></div>;
  }

  if (error || !proposal) {
    return (
      <Card className="text-center py-16 max-w-lg mx-auto">
        <AlertCircle className="w-12 h-12 text-red-300 mx-auto mb-4" />
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Link Not Found</h2>
        <p className="text-gray-500 mb-6">This reschedule link is no longer active or does not exist.</p>
      </Card>
    );
  }

  if (confirmed) {
    const slot = proposal.slots.find(s => s.id === selectedSlotId);
    return (
      <Card className="text-center py-16 max-w-lg mx-auto">
        <div className="w-16 h-16 bg-jungo-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <Check className="w-8 h-8 text-jungo-green-600" />
        </div>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Meeting Rescheduled!</h2>
        <p className="text-gray-500 mb-2">
          Your meeting has been moved to:
        </p>
        <p className="font-medium text-gray-900">
          {slot ? formatDisplayDate(slot.date) : ''} at {slot ? formatTime(slot.start_time) : ''}
        </p>
        <p className="text-sm text-gray-400 mt-4">A confirmation email has been sent to {proposal.client_email}.</p>
      </Card>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6 animate-fade-in">
      <div className="text-center">
        <div className="w-16 h-16 bg-jungo-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <CalendarClock className="w-8 h-8 text-jungo-green-600" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900">Reschedule Your Meeting</h1>
        <p className="text-gray-500 mt-2">
          Hi {proposal.client_name}, please select a new time for your meeting.
        </p>
        {proposal.message && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mt-4 text-left">
            <p className="text-sm text-blue-800 whitespace-pre-wrap">{proposal.message}</p>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">Available Times</h3>
        {proposal.slots.length === 0 ? (
          <Card className="text-center py-12">
            <Clock className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            <p className="text-gray-500">No times have been proposed yet. Please check back later.</p>
          </Card>
        ) : (
          proposal.slots.map(slot => (
            <Card
              key={slot.id}
              padding="sm"
              hover={slot.is_claimed ? false : true}
              onClick={slot.is_claimed ? undefined : () => setSelectedSlotId(slot.id)}
              className={slot.is_claimed ? 'opacity-50' : selectedSlotId === slot.id ? 'ring-2 ring-jungo-green-500' : ''}
            >
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <Clock className="w-4 h-4 text-gray-400" />
                  <div>
                    <p className="font-medium text-gray-900">{formatDisplayDate(slot.date)}</p>
                    <p className="text-sm text-gray-500">at {formatTime(slot.start_time)}</p>
                  </div>
                </div>
                {slot.is_claimed ? (
                  <Badge variant="neutral">Booked</Badge>
                ) : selectedSlotId === slot.id ? (
                  <div className="w-6 h-6 bg-jungo-green-500 rounded-full flex items-center justify-center">
                    <Check className="w-4 h-4 text-white" />
                  </div>
                ) : (
                  <div className="w-6 h-6 border-2 border-gray-300 rounded-full" />
                )}
              </div>
            </Card>
          ))
        )}
      </div>

      {actionError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-red-700">{actionError}</p>
        </div>
      )}

      {selectedSlotId && (
        <div className="flex justify-end">
          <Button
            onClick={handleConfirm}
            loading={confirming}
            icon={<Check className="w-4 h-4" />}
            size="lg"
          >
            Confirm New Time
          </Button>
        </div>
      )}

      <div className="text-center text-sm text-gray-400">
        <Mail className="w-3.5 h-3.5 inline mr-1" />
        Questions? Reply to your confirmation email or contact us directly.
      </div>
    </div>
  );
}
