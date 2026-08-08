import React from 'react'

export default function Loading(): React.ReactElement {
  return (
    <div className="flex flex-col gap-8">
      <h1 className="sr-only">Overview</h1>
      <p role="status">Loading overview…</p>
    </div>
  )
}
