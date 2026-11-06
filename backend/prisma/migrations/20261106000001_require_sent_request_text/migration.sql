BEGIN;

ALTER TABLE "QuoteRequest"
    DROP CONSTRAINT "QuoteRequest_sent_fields_check",
    ADD CONSTRAINT "QuoteRequest_sent_fields_check" CHECK (
        status = 'draft_request' OR (
            category_id IS NOT NULL
            AND COALESCE(spec, '') ~ '[^[:space:]]'
            AND quantity IS NOT NULL AND unit IS NOT NULL AND delivery_mode IS NOT NULL
            AND COALESCE(recipient_name, '') ~ '[^[:space:]]'
            AND COALESCE(recipient_phone, '') ~ '[^[:space:]]'
            AND bidding_deadline IS NOT NULL AND delivery_deadline IS NOT NULL
            AND delivery_deadline > bidding_deadline + INTERVAL '24 hours'
            AND (unit <> 'set' OR COALESCE(unit_set_description, '') ~ '[^[:space:]]')
            AND (delivery_mode <> 'at_buyer_address' OR (
                COALESCE(delivery_region, '') ~ '[^[:space:]]'
                AND COALESCE(delivery_address, '') ~ '[^[:space:]]'
            ))
        )
    );

COMMIT;
