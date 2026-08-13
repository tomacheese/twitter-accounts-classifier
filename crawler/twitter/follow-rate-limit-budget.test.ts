import { describe, expect, it } from 'vitest'
import { FollowRateLimitBudget } from './follow-rate-limit-budget'

describe('FollowRateLimitBudget', () => {
  it('skips optional Following requests once the fallback budget is exhausted', () => {
    const budget = new FollowRateLimitBudget({ now: () => 0, fallbackFollowingRequests: 1 })

    expect(budget.acquireOptionalFollowing()).toBe('allowed')
    expect(budget.acquireOptionalFollowing()).toBe('budget_skipped')
  })

  it('accounts for optional requests recorded before a resumed crawl', () => {
    const budget = new FollowRateLimitBudget({ now: () => 0, fallbackFollowingRequests: 2 })
    budget.restoreOptionalFollowingRequests(2)

    expect(budget.acquireOptionalFollowing()).toBe('budget_skipped')
  })

  it('restores an exhausted Following quota from a checkpoint', () => {
    const budget = new FollowRateLimitBudget({ now: () => 0 })
    budget.restoreFollowingQuota({ rateLimitRemaining: 0, rateLimitReset: 60 })

    expect(budget.acquireOptionalFollowing()).toBe('budget_skipped')
  })

  it('keeps Following and Followers quotas in separate buckets', () => {
    const budget = new FollowRateLimitBudget({ now: () => 0 })
    budget.recordSuccess('Following', { rateLimitRemaining: 0, rateLimitReset: 60 })

    expect(budget.acquireOptionalFollowing()).toBe('budget_skipped')
    expect(budget.canStart('Followers')).toBe(true)
  })

  it('opens the optional Following circuit after a 429 and closes it after the server reset', () => {
    let now = 0
    const budget = new FollowRateLimitBudget({ now: () => now })
    budget.recordRateLimited('Following', { rateLimitReset: 60 })

    expect(budget.acquireOptionalFollowing()).toBe('rate_limit_skipped')
    now = 60_000
    expect(budget.acquireOptionalFollowing()).toBe('allowed')
  })
})
