import React from 'react'

function Skeleton({ className }: { className: string }): React.ReactElement {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded bg-gray-200 motion-reduce:animate-none dark:bg-gray-700 ${className}`}
    />
  )
}

function LoadingStatus({ label }: { label: string }): React.ReactElement {
  return (
    <div aria-busy="true" aria-live="polite" role="status">
      <span className="sr-only">Loading {label}</span>
    </div>
  )
}

export function TableLoading({
  title,
  columnCount,
  rowCount = 8,
}: {
  title: string
  columnCount: number
  rowCount?: number
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-6">
      <LoadingStatus label={title} />
      <h1 className="text-2xl font-semibold">{title}</h1>
      <div aria-hidden="true" className="overflow-hidden rounded-lg border dark:border-gray-700">
        <div className="grid grid-flow-col auto-cols-fr gap-3 bg-gray-100 p-3 dark:bg-gray-700">
          {Array.from({ length: columnCount }, (_, index) => (
            <Skeleton key={index} className="h-5 w-full" />
          ))}
        </div>
        <div className="flex flex-col gap-px bg-gray-200 dark:bg-gray-700">
          {Array.from({ length: rowCount }, (_, rowIndex) => (
            <div
              key={rowIndex}
              className="grid grid-flow-col auto-cols-fr gap-3 bg-white p-3 dark:bg-gray-800"
            >
              {Array.from({ length: columnCount }, (_, columnIndex) => (
                <Skeleton key={columnIndex} className="h-5 w-full" />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function DetailLoading({
  title,
  sectionCount,
}: {
  title: string
  sectionCount: number
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-8">
      <LoadingStatus label={title} />
      <h1 className="sr-only">{title}</h1>
      <Skeleton className="h-5 w-36" />
      <section
        aria-label={title}
        className="rounded-lg border bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800"
      >
        <Skeleton className="h-8 w-60" />
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index}>
              <Skeleton className="h-4 w-20" />
              <Skeleton className="mt-2 h-5 w-28" />
            </div>
          ))}
        </div>
      </section>
      {Array.from({ length: sectionCount }, (_, index) => (
        <section key={index} aria-hidden="true">
          <Skeleton className="h-6 w-40" />
          <div className="mt-3 flex flex-col gap-2">
            {Array.from({ length: 3 }, (_, itemIndex) => (
              <div
                key={itemIndex}
                className="rounded-lg border bg-white p-3 shadow-sm dark:border-gray-700 dark:bg-gray-800"
              >
                <Skeleton className="h-5 w-2/5" />
                <Skeleton className="mt-3 h-5 w-full" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
