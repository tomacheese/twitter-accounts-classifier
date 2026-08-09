// @vitest-environment jsdom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ResponsiveTable, type ResponsiveTableColumn } from './responsive-table'

interface Row {
  id: string
  name: string
  detail: string
}

const columns: ResponsiveTableColumn<Row>[] = [
  { key: 'name', header: 'Name', priority: 'primary', render: (row) => row.name },
  { key: 'detail', header: 'Detail', priority: 'secondary', render: (row) => row.detail },
]
const rows: Row[] = [{ id: 'r-1', name: 'alice', detail: 'x' }]

describe('ResponsiveTable', () => {
  afterEach(() => {
    cleanup()
  })

  it('table 要素で全列を表示する', () => {
    render(<ResponsiveTable columns={columns} rows={rows} rowKey={(row) => row.id} />)
    expect(screen.getByRole('table')).toBeTruthy()
    expect(screen.getAllByText('alice').length).toBeGreaterThan(0)
  })

  it('priority: secondary の列は details 内に折り畳まれる', () => {
    render(<ResponsiveTable columns={columns} rows={rows} rowKey={(row) => row.id} />)
    const detailsElements = screen.getAllByRole('group')
    expect(detailsElements.length).toBeGreaterThan(0)
  })
})
