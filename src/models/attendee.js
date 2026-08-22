/**
 * Attendee State Machine States
 * Explicit states - not a boolean flag.
 */
const AttendeeState = Object.freeze({
  NOT_CHECKED_IN: 'NOT_CHECKED_IN',
  PRINT_REQUESTED: 'PRINT_REQUESTED',
  CHECKED_IN: 'CHECKED_IN',
  PRINT_FAILED: 'PRINT_FAILED',
});

/**
 * Valid state transitions mapping
 * Maps source state to an array of allowed destination states.
 */
const AllowedTransitions = Object.freeze({
  [AttendeeState.NOT_CHECKED_IN]: [AttendeeState.PRINT_REQUESTED],
  [AttendeeState.PRINT_REQUESTED]: [AttendeeState.CHECKED_IN, AttendeeState.PRINT_FAILED],
  [AttendeeState.PRINT_FAILED]: [AttendeeState.PRINT_REQUESTED], // Allows retry
  [AttendeeState.CHECKED_IN]: [], // Terminal state
});

/**
 * Initial seed attendees for Solstice Events Co. conference
 */
const SEED_ATTENDEES = [
  {
    id: 'att-101',
    name: 'Dr. Elena Rostova',
    company: 'Quantum Dynamics Lab',
    title: 'Lead Research Scientist',
    ticketType: 'VIP Speaker',
    qrCode: 'SOLSTICE-2026-ATT-101',
    avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80',
  },
  {
    id: 'att-102',
    name: 'Marcus Vance',
    company: 'Nexus Cybernetics',
    title: 'VP of Infrastructure',
    ticketType: 'All-Access Pass',
    qrCode: 'SOLSTICE-2026-ATT-102',
    avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80',
  },
  {
    id: 'att-103',
    name: 'Amina Al-Mansoor',
    company: 'Apex AI Ventures',
    title: 'Principal Systems Architect',
    ticketType: 'All-Access Pass',
    qrCode: 'SOLSTICE-2026-ATT-103',
    avatar: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=150&auto=format&fit=crop&q=80',
  },
  {
    id: 'att-104',
    name: 'Kai Chen',
    company: 'HyperScale Systems',
    title: 'Cloud Core Engineer',
    ticketType: 'General Admission',
    qrCode: 'SOLSTICE-2026-ATT-104',
    avatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&auto=format&fit=crop&q=80',
  },
  {
    id: 'att-105',
    name: 'Sarah Jenkins',
    company: 'Aurora Biotech',
    title: 'Founder & CEO',
    ticketType: 'Executive Guest',
    qrCode: 'SOLSTICE-2026-ATT-105',
    avatar: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=150&auto=format&fit=crop&q=80',
  },
];

module.exports = {
  AttendeeState,
  AllowedTransitions,
  SEED_ATTENDEES,
};
