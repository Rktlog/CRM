-- CreateTable
CREATE TABLE "budget_targets" (
    "id" UUID NOT NULL,
    "repId" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "quarter" INTEGER NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "budget_targets_repId_year_quarter_key" ON "budget_targets"("repId", "year", "quarter");

-- AddForeignKey
ALTER TABLE "budget_targets" ADD CONSTRAINT "budget_targets_repId_fkey" FOREIGN KEY ("repId") REFERENCES "reps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
