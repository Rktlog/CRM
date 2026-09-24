import { PrismaClient } from '@prisma/client';

// One client for the whole process — don't instantiate PrismaClient
// inside route handlers, it exhausts the connection pool fast.
export const prisma = new PrismaClient();
