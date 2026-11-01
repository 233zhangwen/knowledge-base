-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "docTitle" TEXT,
ADD COLUMN     "effectiveFrom" TIMESTAMP(3),
ADD COLUMN     "supersededBy" TEXT;
