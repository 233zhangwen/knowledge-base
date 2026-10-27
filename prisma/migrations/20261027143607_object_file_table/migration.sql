-- CreateTable
CREATE TABLE "ObjectFile" (
    "key" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "contentType" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ObjectFile_pkey" PRIMARY KEY ("key")
);
