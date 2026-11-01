-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "supersedesRaw" TEXT[] DEFAULT ARRAY[]::TEXT[];
