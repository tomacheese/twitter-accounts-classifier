import { describe, expect, it } from 'vitest'
import { TweetDetailRateLimitBudget } from './tweet-detail-rate-limit-budget'

describe('TweetDetailRateLimitBudget', () => {
  it('allows fetches until the fallback budget is exhausted', () => {
    const now = 0
    const budget = new TweetDetailRateLimitBudget({ now: () => now, fallbackRequests: 2 })

    expect(budget.acquireOptionalFetch()).toBe('allowed')
    expect(budget.acquireOptionalFetch()).toBe('allowed')
    expect(budget.acquireOptionalFetch()).toBe('budget_skipped')
  })

  it('accounts for requests already recorded before a resumed crawl', () => {
    const now = 0
    const budget = new TweetDetailRateLimitBudget({ now: () => now, fallbackRequests: 2 })

    budget.restoreFetchCount(2)

    expect(budget.acquireOptionalFetch()).toBe('budget_skipped')
  })

  it('reflects the real remaining quota once a successful response is recorded', () => {
    const now = 0
    const budget = new TweetDetailRateLimitBudget({ now: () => now, fallbackRequests: 450 })

    budget.recordSuccess({ rateLimitRemaining: 1 })

    expect(budget.acquireOptionalFetch()).toBe('allowed')
    expect(budget.acquireOptionalFetch()).toBe('budget_skipped')
  })

  it('opens the circuit after a 429 and closes it once the server reset passes', () => {
    let now = 0
    const budget = new TweetDetailRateLimitBudget({ now: () => now, fallbackRequests: 450 })

    budget.recordRateLimited({ rateLimitReset: 10 })
    expect(budget.acquireOptionalFetch()).toBe('rate_limit_skipped')

    now = 10_001
    expect(budget.acquireOptionalFetch()).toBe('allowed')
  })

  it('restores an already-open circuit from a checkpoint', () => {
    const now = 0
    const budget = new TweetDetailRateLimitBudget({ now: () => now, fallbackRequests: 450 })

    budget.restoreRateLimit()

    expect(budget.acquireOptionalFetch()).toBe('rate_limit_skipped')
  })
})
