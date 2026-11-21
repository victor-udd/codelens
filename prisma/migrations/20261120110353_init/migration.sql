-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('SNIPPET', 'DIFF');

-- CreateEnum
CREATE TYPE "SupportedLanguage" AS ENUM ('JAVASCRIPT', 'TYPESCRIPT', 'PYTHON', 'GO');

-- CreateEnum
CREATE TYPE "FindingSource" AS ENUM ('STATIC', 'AI');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('INFO', 'WARNING', 'ERROR', 'CRITICAL');

-- CreateEnum
CREATE TYPE "Category" AS ENUM ('SECURITY', 'BUG', 'PERFORMANCE', 'STYLE', 'MAINTAINABILITY');

-- CreateTable
CREATE TABLE "Review" (
    "id" UUID NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "sourceType" "SourceType" NOT NULL,
    "language" "SupportedLanguage" NOT NULL,
    "sourceSizeBytes" INTEGER NOT NULL,
    "options" JSONB,
    "provider" TEXT,
    "model" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "processingStartedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewResult" (
    "id" TEXT NOT NULL,
    "reviewId" UUID NOT NULL,
    "summary" TEXT NOT NULL,
    "details" JSONB,
    "severityCounts" JSONB,
    "latencyMs" INTEGER,
    "tokenUsage" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Finding" (
    "id" TEXT NOT NULL,
    "reviewId" UUID NOT NULL,
    "source" "FindingSource" NOT NULL,
    "severity" "Severity" NOT NULL,
    "category" "Category" NOT NULL,
    "title" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "suggestedFix" TEXT,
    "filePath" TEXT,
    "lineStart" INTEGER,
    "lineEnd" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Finding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Review_status_createdAt_idx" ON "Review"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Review_status_processingStartedAt_idx" ON "Review"("status", "processingStartedAt");

-- CreateIndex
CREATE INDEX "Review_createdAt_id_idx" ON "Review"("createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewResult_reviewId_key" ON "ReviewResult"("reviewId");

-- CreateIndex
CREATE INDEX "Finding_reviewId_idx" ON "Finding"("reviewId");

-- CreateIndex
CREATE INDEX "Finding_reviewId_severity_idx" ON "Finding"("reviewId", "severity");

-- AddForeignKey
ALTER TABLE "ReviewResult" ADD CONSTRAINT "ReviewResult_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE CASCADE ON UPDATE CASCADE;
