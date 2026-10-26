-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "finishReason" TEXT NOT NULL DEFAULT 'complete';

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");
