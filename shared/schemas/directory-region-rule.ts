/*
 * The body of a directory placement rule: the upsert route
 * (directory-region-rules.post.ts) and the placement-check rule preview validate
 * the same shape, so a preview cannot accept a rule the upsert would refuse.
 */
import { z } from 'zod'
import { isRegionAttributeKey, isMatchMode } from '../placement/region-attributes'

export const DirectoryRegionRuleBody = z
  .object({
    attribute: z.string().refine(isRegionAttributeKey, 'unknown region attribute'),
    match_mode: z.string().refine(isMatchMode, "match_mode must be 'exact' or 'prefix'").default('exact'),
    match_value: z.string().trim().min(1).max(200),
    region_id: z.string().uuid().optional(),
    /** A cost-owning unit. Its region becomes the rule's region — never both. */
    org_unit_id: z.string().uuid().optional(),
  })
  .refine(
    (b) => Boolean(b.region_id) !== Boolean(b.org_unit_id),
    'supply exactly one of region_id (a region rule) or org_unit_id (a unit rule)',
  )

export type DirectoryRegionRuleBody = z.infer<typeof DirectoryRegionRuleBody>
