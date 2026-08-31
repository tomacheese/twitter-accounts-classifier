ALTER TABLE "Tweet"
ADD COLUMN "cardDestinationUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "cardDestinationUrlsEvaluated" BOOLEAN NOT NULL DEFAULT false;
