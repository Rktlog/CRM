import { z } from 'zod';

export const createAccountSchema = z.object({
  name: z.string().min(1),
  region: z.string().min(1),
  repId: z.string().uuid(),
  credit: z.enum(['prepay', 'account']),
  type: z.enum(['prospect', 'lead', 'customer']).default('prospect'),
  contactName: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  email: z.string().email().optional(),
});

export const createActivitySchema = z.object({
  accountId: z.string().uuid(),
  type: z.enum(['call', 'email', 'visit', 'remark']),   // a remark is a comment or feedback, logged like the others
  note: z.string().min(1),
  photoUrl: z.string().url().optional(),
  // The order this log is about, if any. It has to be one of this account's orders.
  orderId: z.string().uuid().optional(),
    occurredAt: z.string().datetime().optional(),
});

export const updateActivitySchema = z.object({
  type: z.enum(['call', 'email', 'visit', 'remark']).optional(),
  note: z.string().min(1).optional(),
    occurredAt: z.string().datetime().optional(),
});