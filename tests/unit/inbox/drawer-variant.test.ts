/*
 * Inbox drawer-body routing — unit test.
 *
 * Pins the category → drawer-body variant mapping that InboxDrawer
 * uses. The mapping is exported from the shared types module so the
 * test doesn't need to mount Vue.
 */
import { describe, it, expect } from 'vitest'
import { categoryLabel, variantForCategory } from '../../../app/components/inbox/types'

describe('variantForCategory', () => {
  it('routes over-budget category to the over-budget body', () => {
    expect(variantForCategory('over-budget')).toBe('over-budget')
  })

  it('routes velocity-warning to the velocity body', () => {
    expect(variantForCategory('velocity-warning')).toBe('velocity')
  })

  it('routes sync-conflict and structural-conflict to the sync-conflict body', () => {
    expect(variantForCategory('sync-conflict')).toBe('sync-conflict')
    expect(variantForCategory('structural-conflict')).toBe('sync-conflict')
  })

  it('routes untagged-backlog to the untagged body', () => {
    expect(variantForCategory('untagged-backlog')).toBe('untagged')
  })

  it('routes escalated over-emission flags to the over-emission body', () => {
    expect(variantForCategory('over-emission-escalated')).toBe('over-emission')
  })

  it('routes personal-subscription prompts to the declaration guidance body', () => {
    expect(variantForCategory('personal-subscription-prompt')).toBe('personal-subscription')
  })

  it('routes both project-request categories to the project-request body', () => {
    expect(variantForCategory('project-request')).toBe('project-request')
    expect(variantForCategory('project-request-decided')).toBe('project-request')
  })

  it('routes both budget-request categories to the budget-request body', () => {
    expect(variantForCategory('quota-request')).toBe('budget-request')
    expect(variantForCategory('quota-request-decided')).toBe('budget-request')
  })

  it('labels budget-request categories in words, never the raw quota key', () => {
    expect(categoryLabel('quota-request')).toBe('Budget request')
    expect(categoryLabel('quota-request-decided')).toBe('Budget decision')
    expect(categoryLabel('over-budget')).toBe('Over budget')
    expect(categoryLabel('something-new')).toBe('something-new')
  })

  it('falls back to generic for unknown categories', () => {
    expect(variantForCategory('connector-health')).toBe('generic')
    expect(variantForCategory('unknown')).toBe('generic')
    expect(variantForCategory('')).toBe('generic')
  })
})
