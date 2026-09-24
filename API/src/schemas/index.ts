import { z } from 'zod';

export const createAccountSchema = z.object({
  name: z.string().min(1),
  region: z.string().min(1),
  repId: z.string().uuid(),
  credit: z.enum(['prepay', 'account']),
  type: z.enum(['prospect', 'customer']).default('prospect'),
  contactName: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  email: z.string().email().optional(),
});

export const createActivitySchema = z.object({
  accountId: z.string().uuid(),
  type: z.enum(['call', 'email', 'visit']),
  note: z.string().min(1),
  photoUrl: z.string().url().optional(),
});

export const updateActivitySchema = z.object({
  type: z.enum(['call', 'email', 'visit']).optional(),
  note: z.string().min(1).optional(),
});
