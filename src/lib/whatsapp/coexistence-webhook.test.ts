import { describe, expect, it, vi } from 'vitest'
import {
  handleCoexistenceWebhookChange,
  isCoexistenceWebhookChange,
  isCoexistenceWebhookField,
  type CoexistenceWebhookChange,
} from './coexistence-webhook'

describe('coexistence-webhook', () => {
  describe('detection', () => {
    it('identifies coexistence webhook fields', () => {
      expect(isCoexistenceWebhookField('smb_message_echoes')).toBe(true)
      expect(isCoexistenceWebhookField('message_echoes')).toBe(true)
      expect(isCoexistenceWebhookField('messages')).toBe(false)
      expect(isCoexistenceWebhookField('statuses')).toBe(false)
    })

    it('identifies coexistence webhook changes', () => {
      expect(
        isCoexistenceWebhookChange({
          field: 'smb_message_echoes',
          value: {},
        })
      ).toBe(true)

      expect(
        isCoexistenceWebhookChange({
          field: 'messages',
          value: {
            message_echoes: [
              {
                id: 'wamid.123',
                from: '15551234567',
                to: '15559876543',
                timestamp: '1739321000',
                type: 'text',
              },
            ],
          },
        })
      ).toBe(true)

      expect(
        isCoexistenceWebhookChange({
          field: 'messages',
          value: { messages: [] },
        })
      ).toBe(false)
    })
  })

  describe('handleCoexistenceWebhookChange', () => {
    it('processes text message echo, inserts message as agent and resets unread_count', async () => {
      const insertedRows: Record<string, unknown>[] = []
      const updatedConversations: Record<string, unknown>[] = []
      const updatedFlowRuns: Record<string, unknown>[] = []

      const mockDb: any = {
        from: vi.fn((table: string) => {
          if (table === 'whatsapp_config') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: 'cfg-1',
                      account_id: 'acc-1',
                      user_id: 'usr-admin',
                    },
                    error: null,
                  }),
                }),
              }),
            }
          }

          if (table === 'contacts') {
            return {
              select: () => ({
                eq: () => ({
                  like: () => Promise.resolve({ data: [{ id: 'contact-1', phone: '15559876543' }], error: null }),
                }),
              }),
            }
          }

          if (table === 'conversations') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    order: () => ({
                      limit: () => ({
                        maybeSingle: async () => ({
                          data: { id: 'conv-1' },
                          error: null,
                        }),
                      }),
                    }),
                  }),
                }),
              }),
              update: (payload: Record<string, unknown>) => {
                updatedConversations.push(payload)
                return {
                  eq: () => Promise.resolve({ error: null }),
                }
              },
            }
          }

          if (table === 'messages') {
            return {
              upsert: (payload: Record<string, unknown>) => {
                insertedRows.push(payload)
                return {
                  select: () => Promise.resolve({ data: [{ id: 'msg-1' }], error: null }),
                }
              },
            }
          }

          if (table === 'flow_runs') {
            return {
              update: (payload: Record<string, unknown>) => {
                updatedFlowRuns.push(payload)
                return {
                  eq: () => ({
                    eq: () => ({
                      eq: () => Promise.resolve({ error: null }),
                    }),
                  }),
                }
              },
            }
          }

          return {
            select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
          }
        }),
      }

      const change: CoexistenceWebhookChange = {
        field: 'smb_message_echoes',
        value: {
          metadata: {
            display_phone_number: '15551234567',
            phone_number_id: 'phone-num-1',
          },
          message_echoes: [
            {
              id: 'wamid.ECHO1',
              from: '15551234567',
              to: '15559876543',
              timestamp: '1739321000',
              type: 'text',
              text: {
                body: 'Hello from mobile WhatsApp Business app!',
              },
            },
          ],
        },
      }

      await handleCoexistenceWebhookChange(change, mockDb)

      expect(insertedRows.length).toBe(1)
      expect(insertedRows[0]).toMatchObject({
        conversation_id: 'conv-1',
        sender_type: 'agent',
        content_type: 'text',
        content_text: 'Hello from mobile WhatsApp Business app!',
        message_id: 'wamid.ECHO1',
        status: 'delivered',
      })

      expect(updatedConversations.length).toBe(1)
      expect(updatedConversations[0]).toMatchObject({
        last_message_text: 'Hello from mobile WhatsApp Business app!',
        unread_count: 0,
      })

      expect(updatedFlowRuns.length).toBe(1)
      expect(updatedFlowRuns[0]).toMatchObject({
        status: 'paused_by_agent',
        end_reason: 'agent_replied',
      })
    })

    it('handles media message echoes', async () => {
      const insertedRows: Record<string, unknown>[] = []

      const mockDb: any = {
        from: vi.fn((table: string) => {
          if (table === 'whatsapp_config') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { id: 'cfg-1', account_id: 'acc-1', user_id: 'usr-admin' },
                    error: null,
                  }),
                }),
              }),
            }
          }
          if (table === 'contacts') {
            return {
              select: () => ({
                eq: () => ({
                  like: () => Promise.resolve({ data: [{ id: 'contact-1', phone: '15559876543' }], error: null }),
                }),
              }),
            }
          }
          if (table === 'conversations') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    order: () => ({
                      limit: () => ({
                        maybeSingle: async () => ({ data: { id: 'conv-1' }, error: null }),
                      }),
                    }),
                  }),
                }),
              }),
              update: () => ({ eq: () => Promise.resolve({ error: null }) }),
            }
          }
          if (table === 'messages') {
            return {
              upsert: (payload: Record<string, unknown>) => {
                insertedRows.push(payload)
                return {
                  select: () => Promise.resolve({ data: [{ id: 'msg-1' }], error: null }),
                }
              },
            }
          }
          if (table === 'flow_runs') {
            return {
              update: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }),
            }
          }
          return {}
        }),
      }

      const change: CoexistenceWebhookChange = {
        field: 'smb_message_echoes',
        value: {
          metadata: {
            display_phone_number: '15551234567',
            phone_number_id: 'phone-num-1',
          },
          message_echoes: [
            {
              id: 'wamid.MEDIA1',
              from: '15551234567',
              to: '15559876543',
              timestamp: '1739321000',
              type: 'image',
              image: {
                id: 'media-meta-id-123',
                mime_type: 'image/jpeg',
                caption: 'Check this out',
              },
            },
          ],
        },
      }

      await handleCoexistenceWebhookChange(change, mockDb)

      expect(insertedRows.length).toBe(1)
      expect(insertedRows[0]).toMatchObject({
        conversation_id: 'conv-1',
        sender_type: 'agent',
        content_type: 'image',
        content_text: 'Check this out',
        media_url: '/api/whatsapp/media/media-meta-id-123',
        media_type: 'image/jpeg',
        message_id: 'wamid.MEDIA1',
      })
    })

    it('handles message revoke (delete from mobile)', async () => {
      const messageUpdates: Record<string, unknown>[] = []
      const convUpdates: Record<string, unknown>[] = []

      const mockDb: any = {
        from: vi.fn((table: string) => {
          if (table === 'whatsapp_config') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { id: 'cfg-1', account_id: 'acc-1', user_id: 'usr-admin' },
                    error: null,
                  }),
                }),
              }),
            }
          }
          if (table === 'messages') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { id: 'msg-uuid-1', conversation_id: 'conv-1', content_text: 'Original message' },
                    error: null,
                  }),
                }),
              }),
              update: (payload: Record<string, unknown>) => {
                messageUpdates.push(payload)
                return {
                  eq: () => Promise.resolve({ error: null }),
                }
              },
            }
          }
          if (table === 'conversations') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { id: 'conv-1', last_message_text: 'Original message' },
                    error: null,
                  }),
                }),
              }),
              update: (payload: Record<string, unknown>) => {
                convUpdates.push(payload)
                return {
                  eq: () => Promise.resolve({ error: null }),
                }
              },
            }
          }
          return {}
        }),
      }

      const change: CoexistenceWebhookChange = {
        field: 'smb_message_echoes',
        value: {
          metadata: {
            display_phone_number: '15551234567',
            phone_number_id: 'phone-num-1',
          },
          message_echoes: [
            {
              id: 'wamid.REVOKE1',
              from: '15551234567',
              to: '15559876543',
              timestamp: '1739321000',
              type: 'revoke',
              revoke: {
                original_message_id: 'wamid.ORIGINAL',
              },
            },
          ],
        },
      }

      await handleCoexistenceWebhookChange(change, mockDb)

      expect(messageUpdates.length).toBe(1)
      expect(messageUpdates[0]).toEqual({
        content_text: 'This message was deleted',
      })

      expect(convUpdates.length).toBe(1)
      expect(convUpdates[0]).toMatchObject({
        last_message_text: 'This message was deleted',
      })
    })

    it('handles message edit (edited from mobile)', async () => {
      const messageUpdates: Record<string, unknown>[] = []

      const mockDb: any = {
        from: vi.fn((table: string) => {
          if (table === 'whatsapp_config') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { id: 'cfg-1', account_id: 'acc-1', user_id: 'usr-admin' },
                    error: null,
                  }),
                }),
              }),
            }
          }
          if (table === 'messages') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { id: 'msg-uuid-1', conversation_id: 'conv-1', content_text: 'Old text' },
                    error: null,
                  }),
                }),
              }),
              update: (payload: Record<string, unknown>) => {
                messageUpdates.push(payload)
                return {
                  eq: () => Promise.resolve({ error: null }),
                }
              },
            }
          }
          if (table === 'conversations') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { id: 'conv-1', last_message_text: 'Old text' },
                    error: null,
                  }),
                }),
              }),
              update: () => ({
                eq: () => Promise.resolve({ error: null }),
              }),
            }
          }
          return {}
        }),
      }

      const change: CoexistenceWebhookChange = {
        field: 'smb_message_echoes',
        value: {
          metadata: {
            display_phone_number: '15551234567',
            phone_number_id: 'phone-num-1',
          },
          message_echoes: [
            {
              id: 'wamid.EDIT1',
              from: '15551234567',
              to: '15559876543',
              timestamp: '1739321000',
              type: 'edit',
              edit: {
                original_message_id: 'wamid.ORIGINAL',
                message: {
                  body: 'Updated text content',
                },
              },
            },
          ],
        },
      }

      await handleCoexistenceWebhookChange(change, mockDb)

      expect(messageUpdates.length).toBe(1)
      expect(messageUpdates[0]).toEqual({
        content_text: 'Updated text content',
      })
    })
  })
})
