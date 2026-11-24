import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ClaimPilot — Delivery Chargeback Reconciliation & Recovery Engine',
  description:
    'B2B Restaurant POS Electronic Journal & DoorDash Payout Reconciliation, Confidence Scoring, and Evidence Packet Platform.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        {children}
      </body>
    </html>
  );
}
