-- ============================================================
-- 043_whatsapp_calls
--
-- Adds support for WhatsApp Business Calling API (VoIP / WebRTC).
-- Enables incoming and outgoing voice calls directly in the CRM:
-- - Tracks call lifecycle (ringing, accepted, rejected, terminated, missed)
-- - Stores WebRTC SDP negotiation data (offer, answer)
-- - Records call duration and which agent answered the call
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  call_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  status TEXT NOT NULL DEFAULT 'ringing' CHECK (status IN ('ringing', 'accepted', 'rejected', 'terminated', 'missed', 'failed')),
  from_phone TEXT NOT NULL,
  to_phone TEXT NOT NULL,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  answered_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER DEFAULT 0,
  sdp_offer TEXT,
  sdp_answer TEXT,
  agent_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_whatsapp_calls_call_id UNIQUE (call_id)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_calls_account_id ON whatsapp_calls(account_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_calls_contact_id ON whatsapp_calls(contact_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_calls_status ON whatsapp_calls(status);
CREATE INDEX IF NOT EXISTS idx_whatsapp_calls_started_at ON whatsapp_calls(started_at DESC);

-- Enable Row Level Security
ALTER TABLE whatsapp_calls ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if re-running
DROP POLICY IF EXISTS "Account members can read calls" ON whatsapp_calls;
DROP POLICY IF EXISTS "Account members can insert calls" ON whatsapp_calls;
DROP POLICY IF EXISTS "Account members can update calls" ON whatsapp_calls;

-- Account members can view all calls for their account
CREATE POLICY "Account members can read calls" ON whatsapp_calls
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM account_members
      WHERE account_members.account_id = whatsapp_calls.account_id
        AND account_members.user_id = auth.uid()
    )
    OR
    EXISTS (
      SELECT 1 FROM accounts
      WHERE accounts.id = whatsapp_calls.account_id
        AND accounts.owner_user_id = auth.uid()
    )
  );

-- Account members (Agent+) can insert calls
CREATE POLICY "Account members can insert calls" ON whatsapp_calls
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM account_members
      WHERE account_members.account_id = whatsapp_calls.account_id
        AND account_members.user_id = auth.uid()
    )
    OR
    EXISTS (
      SELECT 1 FROM accounts
      WHERE accounts.id = whatsapp_calls.account_id
        AND accounts.owner_user_id = auth.uid()
    )
  );

-- Account members can update calls (e.g. answer, terminate, duration)
CREATE POLICY "Account members can update calls" ON whatsapp_calls
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM account_members
      WHERE account_members.account_id = whatsapp_calls.account_id
        AND account_members.user_id = auth.uid()
    )
    OR
    EXISTS (
      SELECT 1 FROM accounts
      WHERE accounts.id = whatsapp_calls.account_id
        AND accounts.owner_user_id = auth.uid()
    )
  );

-- Enable Supabase Realtime for whatsapp_calls table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
      AND schemaname = 'public' 
      AND tablename = 'whatsapp_calls'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_calls;
  END IF;
END $$;
