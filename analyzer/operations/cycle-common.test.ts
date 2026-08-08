import { describe, it, expect } from 'vitest'
import { deriveCycleStatus } from './cycle-common'

describe('deriveCycleStatus', () => {
  it('4 Stage すべて succeeded なら succeeded を返す', () => {
    expect(deriveCycleStatus(['succeeded', 'succeeded', 'succeeded', 'succeeded'])).toBe(
      'succeeded',
    )
  })

  it('起点 Stage が succeeded で後続に failed があれば partial を返す', () => {
    expect(deriveCycleStatus(['succeeded', 'failed', 'succeeded', 'succeeded'])).toBe('partial')
  })

  it('起点 Stage 自体が failed なら failed を返す', () => {
    expect(deriveCycleStatus(['failed', 'waiting', 'waiting', 'waiting'])).toBe('failed')
  })

  it('failed が無く running があれば running を返す', () => {
    expect(deriveCycleStatus(['succeeded', 'running', 'waiting'])).toBe('running')
  })

  it('未着手の Stage だけが残っていれば scheduled を返す', () => {
    expect(deriveCycleStatus(['succeeded', 'waiting', 'waiting'])).toBe('scheduled')
  })

  it('起点 Stage が succeeded で後続に skipped があれば partial を返す', () => {
    expect(deriveCycleStatus(['succeeded', 'succeeded', 'succeeded', 'skipped'])).toBe('partial')
  })

  it('起点 Stage 自体が failed で後続が skipped なら failed を返す', () => {
    expect(deriveCycleStatus(['failed', 'skipped', 'skipped', 'skipped'])).toBe('failed')
  })

  it('起点 Stage が partial なら Cycle 全体も partial を返す', () => {
    expect(deriveCycleStatus(['partial', 'succeeded', 'succeeded'])).toBe('partial')
  })

  it('起点 Stage が failed なら後続に partial があっても failed を返す', () => {
    expect(deriveCycleStatus(['failed', 'partial'])).toBe('failed')
  })
})
