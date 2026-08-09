-- CreateTable
CREATE TABLE "ComponentBuildIdentity" (
    "component" TEXT NOT NULL,
    "applicationVersion" TEXT NOT NULL,
    "gitRevision" TEXT NOT NULL,
    "buildTime" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComponentBuildIdentity_pkey" PRIMARY KEY ("component")
);
