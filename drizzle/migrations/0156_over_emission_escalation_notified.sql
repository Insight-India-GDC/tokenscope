-- 0156 — an indexable "notified" watermark for escalated over-emission flags.
--
-- Escalated flags accumulate: only a materially larger excess makes the
-- detector re-open one. notifyEscalatedOverEmission found the unnotified ones
-- with an anti-join on inbox_item across all of them, on every run. The watermark records when the
-- admins were last notified; a flag needs notifying while it is escalated and
-- the watermark is unset or older than its latest escalation (resolved_at), so
-- a flag re-escalated after the detector re-opened it is notified again. The
-- partial index holds only those flags, ordered the way the worker reads them.

ALTER TABLE over_emission ADD COLUMN escalation_notified_at timestamptz;

-- Flags already notified under the anti-join keep their state.
UPDATE over_emission oe
SET escalation_notified_at = n.notified_at
FROM (
  SELECT ii.related_entity_id AS id, max(ii.created_at) AS notified_at
  FROM inbox_item ii
  WHERE ii.category = 'over-emission-escalated'
    AND ii.related_entity_kind = 'over-emission'
  GROUP BY ii.related_entity_id
) n
WHERE n.id = oe.id AND oe.state = 'escalated' AND n.notified_at >= oe.resolved_at;

CREATE INDEX over_emission_escalation_unnotified
  ON over_emission (resolved_at, id)
  WHERE state = 'escalated'
    AND (escalation_notified_at IS NULL OR escalation_notified_at < resolved_at);
