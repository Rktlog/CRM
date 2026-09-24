-- CreateEnum
CREATE TYPE "RepRole" AS ENUM ('rep', 'manager');

-- CreateEnum
CREATE TYPE "RepType" AS ENUM ('field', 'remote');

-- CreateEnum
CREATE TYPE "CreditTerm" AS ENUM ('prepay', 'account');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('prospect', 'customer');

-- CreateEnum
CREATE TYPE "Stage" AS ENUM ('new_lead', 'approached', 'product_selected', 'quote_sent', 'payment_cleared', 'dispatched');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('call', 'email', 'visit');

-- CreateTable
CREATE TABLE "reps" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "RepType" NOT NULL,
    "role" "RepRole" NOT NULL DEFAULT 'rep',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "rep_id" UUID NOT NULL,
    "credit" "CreditTerm" NOT NULL,
    "type" "AccountType" NOT NULL DEFAULT 'prospect',
    "stage" "Stage" NOT NULL DEFAULT 'new_lead',
    "spend_30" INTEGER NOT NULL DEFAULT 0,
    "spend_90" INTEGER NOT NULL DEFAULT 0,
    "spend_365" INTEGER NOT NULL DEFAULT 0,
    "last_order_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "rep_id" UUID NOT NULL,
    "type" "ActivityType" NOT NULL,
    "note" TEXT NOT NULL,
    "photo_url" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL,
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'cin7',
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "quotes_number_key" ON "quotes"("number");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_rep_id_fkey" FOREIGN KEY ("rep_id") REFERENCES "reps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity" ADD CONSTRAINT "activity_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity" ADD CONSTRAINT "activity_rep_id_fkey" FOREIGN KEY ("rep_id") REFERENCES "reps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
