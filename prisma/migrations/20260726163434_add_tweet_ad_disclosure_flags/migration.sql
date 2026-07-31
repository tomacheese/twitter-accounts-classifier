-- AlterTable
ALTER TABLE "Tweet" ADD COLUMN     "isPaidPromotion" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isPromoted" BOOLEAN NOT NULL DEFAULT false;
