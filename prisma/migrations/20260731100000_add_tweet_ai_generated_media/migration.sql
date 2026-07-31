-- AlterTable
-- hasAiGeneratedMedia has no default (NULL) rather than defaulting to false: existing
-- rows collected before this column existed never had their AI-generated-media
-- disclosure evaluated at all, and defaulting them to false would misrepresent that
-- gap as "checked and confirmed not AI-generated" instead of "unknown".
ALTER TABLE "Tweet" ADD COLUMN     "hasAiGeneratedMedia" BOOLEAN,
ADD COLUMN     "aiGeneratedDetectionSource" TEXT;
