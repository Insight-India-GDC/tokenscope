/*
 * useProjectCreate — one atomic call per submit, routed by who is creating:
 * admins to /admin/projects, PMO-list holders to /projects.
 */
import { describe, it, expect, vi } from 'vitest'
import { afterCreatePath, useProjectCreate } from '../../../app/composables/useProjectCreate'

const BODY = {
  code: 'ACME-2026',
  display_name: 'Acme platform rebuild',
  type: 'billable',
  region_id: 'r1',
  cost_owning_unit_id: 'cou1',
  pm_teammate_id: 't1',
  budget: { amount_usd: '1000.00', from: '2026-06-01T00:00:00Z', to: '2026-07-01T00:00:00Z' },
}

describe('useProjectCreate', () => {
  it('admin route: one POST to /admin/projects, returns the created project', async () => {
    const post = vi.fn().mockResolvedValueOnce({ id: 'p1', code: 'ACME-2026', allocation_id: 'a1' })
    const c = useProjectCreate({ post: post as never })
    expect(await c.submit('admin', BODY)).toEqual({ id: 'p1', code: 'ACME-2026', allocation_id: 'a1' })
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith('/api/v1/admin/projects', BODY)
    expect(c.error.value).toBeNull()
  })

  it('PMO route: one POST to /projects', async () => {
    const post = vi.fn().mockResolvedValueOnce({ id: 'p1', code: 'ACME-2026', allocation_id: 'a1' })
    const c = useProjectCreate({ post: post as never })
    await c.submit('pmo', BODY)
    expect(post).toHaveBeenCalledWith('/api/v1/projects', BODY)
  })

  it('a failure surfaces the server detail and returns null; a retry posts again', async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 409, data: { data: { detail: 'Project code taken.' } } })
      .mockResolvedValueOnce({ id: 'p2', code: 'ACME-2027', allocation_id: 'a2' })
    const c = useProjectCreate({ post: post as never })
    expect(await c.submit('admin', BODY)).toBeNull()
    expect(c.error.value).toContain('Project code taken.')
    expect(c.outcomeUnknown.value).toBe(false)
    expect(await c.submit('admin', { ...BODY, code: 'ACME-2027' })).toMatchObject({ id: 'p2' })
    expect(c.error.value).toBeNull()
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('a failure with no server refusal behind it marks the outcome unknown (the project may exist)', async () => {
    const post = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockRejectedValueOnce({ statusCode: 502, data: {} })
    const c = useProjectCreate({ post: post as never })
    expect(await c.submit('admin', BODY)).toBeNull()
    expect(c.outcomeUnknown.value).toBe(true)
    expect(await c.submit('admin', BODY)).toBeNull()
    expect(c.outcomeUnknown.value).toBe(true)
  })
})

describe('afterCreatePath', () => {
  const created = { id: 'p1', code: 'ACME 1', allocation_id: 'a1' }
  it('an admin lands on the new baseline', () => {
    expect(afterCreatePath('admin', created, { pmId: 't2', viewerId: 't1' })).toBe('/allocations/a1')
  })
  it('a PMO holder who is the PM opens the project page', () => {
    expect(afterCreatePath('pmo', created, { pmId: 't1', viewerId: 't1' })).toBe('/projects/ACME%201')
  })
  it('a PMO holder who named someone else goes to My projects, which names the project (the page would 404)', () => {
    expect(afterCreatePath('pmo', created, { pmId: 't2', viewerId: 't1' })).toBe('/projects?created=ACME%201')
    expect(afterCreatePath('pmo', created, { pmId: null, viewerId: null })).toBe('/projects?created=ACME%201')
  })
})
