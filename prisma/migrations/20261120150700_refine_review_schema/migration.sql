/*
  Warnings:

  - You are about to drop the column `completedAt` on the `ReviewResult` table. All the data in the column will be lost.
  - You are about to drop the column `details` on the `ReviewResult` table. All the data in the column will be lost.
  - You are about to drop the column `severityCounts` on the `ReviewResult` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "ReviewResult" DROP COLUMN "completedAt",
DROP COLUMN "details",
DROP COLUMN "severityCounts";

-- Prisma 6 cannot express CHECK constraints in schema.prisma.
-- These enforce the documented field constraints and must be preserved in future migrations.

-- AlterTable
ALTER TABLE "Review" ADD CONSTRAINT "Review_sourceSizeBytes_positive" CHECK ("sourceSizeBytes" > 0);

-- AlterTable
ALTER TABLE "Review" ADD CONSTRAINT "Review_attemptCount_nonnegative" CHECK ("attemptCount" >= 0);

-- AlterTable
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_lineStart_positive" CHECK ("lineStart" IS NULL OR "lineStart" > 0);

-- AlterTable
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_lineEnd_positive" CHECK ("lineEnd" IS NULL OR "lineEnd" > 0);

-- AlterTable
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_lineEnd_not_before_lineStart" CHECK ("lineEnd" IS NULL OR "lineStart" IS NULL OR "lineEnd" >= "lineStart");
