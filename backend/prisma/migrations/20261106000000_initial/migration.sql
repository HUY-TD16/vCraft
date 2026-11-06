BEGIN;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Account" (
    "id" BIGSERIAL NOT NULL,
    "username" VARCHAR(32) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "display_name" VARCHAR(100),
    "phone" VARCHAR(20),
    "role" VARCHAR(10) NOT NULL,
    "auth_version" INTEGER NOT NULL DEFAULT 1,
    "is_login_locked" BOOLEAN NOT NULL DEFAULT false,
    "temp_password_expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workshop" (
    "id" BIGSERIAL NOT NULL,
    "account_id" BIGINT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "story" TEXT,
    "address" VARCHAR(500),
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "accepting_visitors" BOOLEAN NOT NULL DEFAULT false,
    "avatar_image_id" BIGINT,
    "status" VARCHAR(15) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Workshop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkshopStatusLog" (
    "id" BIGSERIAL NOT NULL,
    "workshop_id" BIGINT NOT NULL,
    "prev_status" VARCHAR(15),
    "new_status" VARCHAR(15) NOT NULL,
    "performed_by" BIGINT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkshopStatusLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Certificate" (
    "id" BIGSERIAL NOT NULL,
    "workshop_id" BIGINT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "image_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Certificate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" BIGSERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" BIGSERIAL NOT NULL,
    "workshop_id" BIGINT NOT NULL,
    "batch_id" BIGINT NOT NULL,
    "category_id" BIGINT NOT NULL,
    "name" VARCHAR(300) NOT NULL,
    "price" DECIMAL(15,0) NOT NULL,
    "description" TEXT,
    "status" VARCHAR(10) NOT NULL,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Batch" (
    "id" BIGSERIAL NOT NULL,
    "workshop_id" BIGINT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "qr_token" VARCHAR(64) NOT NULL,
    "status" VARCHAR(10) NOT NULL,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" BIGSERIAL NOT NULL,
    "batch_id" BIGINT NOT NULL,
    "performed_by" BIGINT NOT NULL,
    "stage" VARCHAR(200) NOT NULL,
    "performed_at" TIMESTAMPTZ(3) NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEditHistory" (
    "id" BIGSERIAL NOT NULL,
    "journal_entry_id" BIGINT NOT NULL,
    "edited_by" BIGINT NOT NULL,
    "prev_stage" VARCHAR(200) NOT NULL,
    "prev_performed_at" TIMESTAMPTZ(3) NOT NULL,
    "prev_notes" TEXT,
    "edited_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "JournalEditHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsPost" (
    "id" BIGSERIAL NOT NULL,
    "created_by" BIGINT NOT NULL,
    "updated_by" BIGINT,
    "title" VARCHAR(300) NOT NULL,
    "content" TEXT NOT NULL,
    "post_type" VARCHAR(30) NOT NULL,
    "status" VARCHAR(10) NOT NULL,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "NewsPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteRequest" (
    "id" BIGSERIAL NOT NULL,
    "buyer_id" BIGINT NOT NULL,
    "category_id" BIGINT,
    "spec" TEXT,
    "quantity" INTEGER,
    "unit" VARCHAR(10),
    "unit_set_description" TEXT,
    "status" VARCHAR(25) NOT NULL,
    "delivery_mode" VARCHAR(20),
    "delivery_region" VARCHAR(200),
    "delivery_address" TEXT,
    "recipient_name" VARCHAR(200),
    "recipient_phone" VARCHAR(20),
    "bidding_deadline" TIMESTAMPTZ(3),
    "delivery_deadline" TIMESTAMPTZ(3),
    "bidding_closed_at" TIMESTAMPTZ(3),
    "split_requested_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by" BIGINT,
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "QuoteRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactEditHistory" (
    "id" BIGSERIAL NOT NULL,
    "request_id" BIGINT NOT NULL,
    "edited_by" BIGINT NOT NULL,
    "prev_recipient_name" VARCHAR(200) NOT NULL,
    "prev_recipient_phone" VARCHAR(20) NOT NULL,
    "new_recipient_name" VARCHAR(200) NOT NULL,
    "new_recipient_phone" VARCHAR(20) NOT NULL,
    "edited_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL,

    CONSTRAINT "ContactEditHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestRecipient" (
    "id" BIGSERIAL NOT NULL,
    "request_id" BIGINT NOT NULL,
    "workshop_id" BIGINT NOT NULL,
    "response_status" VARCHAR(15) NOT NULL,
    "decline_reason" TEXT,
    "responded_by" BIGINT,
    "responded_at" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "RequestRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" BIGSERIAL NOT NULL,
    "request_id" BIGINT NOT NULL,
    "workshop_id" BIGINT NOT NULL,
    "unit_price" DECIMAL(15,0) NOT NULL,
    "max_quantity" INTEGER NOT NULL,
    "bid_accept_deadline" TIMESTAMPTZ(3) NOT NULL,
    "committed_delivery_at" TIMESTAMPTZ(3) NOT NULL,
    "status" VARCHAR(10) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "withdraw_reason" TEXT,
    "withdrawn_by" BIGINT,
    "withdrawn_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SplitProposal" (
    "id" BIGSERIAL NOT NULL,
    "request_id" BIGINT NOT NULL,
    "created_by" BIGINT NOT NULL,
    "status" VARCHAR(10) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "expired_at" TIMESTAMPTZ(3),
    "expire_reason" VARCHAR(40),
    "reject_reason" TEXT,
    "rejected_by" BIGINT,
    "rejected_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SplitProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SplitProposalItem" (
    "id" BIGSERIAL NOT NULL,
    "request_id" BIGINT NOT NULL,
    "quote_version" INTEGER NOT NULL,
    "proposal_id" BIGINT NOT NULL,
    "workshop_id" BIGINT NOT NULL,
    "quote_id" BIGINT NOT NULL,
    "allocated_quantity" INTEGER NOT NULL,

    CONSTRAINT "SplitProposalItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Allocation" (
    "id" BIGSERIAL NOT NULL,
    "request_id" BIGINT NOT NULL,
    "workshop_id" BIGINT NOT NULL,
    "quote_id" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(15,0) NOT NULL,
    "committed_delivery_at" TIMESTAMPTZ(3) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "started_at" TIMESTAMPTZ(3),
    "started_by" BIGINT,
    "handed_over_at" TIMESTAMPTZ(3),
    "handed_over_by" BIGINT,
    "delivery_note" TEXT,
    "admin_handed_over" BOOLEAN NOT NULL DEFAULT false,
    "admin_delivery_evidence" TEXT,
    "admin_handover_reason" TEXT,
    "admin_handover_actual_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Allocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllocationBatch" (
    "id" BIGSERIAL NOT NULL,
    "workshop_id" BIGINT NOT NULL,
    "allocation_id" BIGINT NOT NULL,
    "batch_id" BIGINT NOT NULL,
    "linked_quantity" INTEGER NOT NULL,
    "linked_at" TIMESTAMPTZ(3) NOT NULL,
    "linked_by" BIGINT NOT NULL,

    CONSTRAINT "AllocationBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllocationLog" (
    "id" BIGSERIAL NOT NULL,
    "allocation_id" BIGINT NOT NULL,
    "event_type" VARCHAR(40) NOT NULL,
    "evidence" TEXT,
    "prev_status" VARCHAR(20),
    "new_status" VARCHAR(20) NOT NULL,
    "performed_by" BIGINT NOT NULL,
    "note" TEXT,
    "is_admin_action" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AllocationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatusLog" (
    "id" BIGSERIAL NOT NULL,
    "request_id" BIGINT NOT NULL,
    "event_type" VARCHAR(40) NOT NULL,
    "evidence" TEXT,
    "prev_status" VARCHAR(25),
    "new_status" VARCHAR(25) NOT NULL,
    "performed_by" BIGINT,
    "note" TEXT,
    "is_admin_action" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatusLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Image" (
    "id" BIGSERIAL NOT NULL,
    "uploaded_by" BIGINT NOT NULL,
    "context_type" VARCHAR(30) NOT NULL,
    "context_id" BIGINT,
    "storage_key" VARCHAR(255),
    "thumbnail_key" VARCHAR(255) NOT NULL,
    "display_key" VARCHAR(255) NOT NULL,
    "original_size_bytes" INTEGER NOT NULL,
    "thumbnail_size_bytes" BIGINT NOT NULL,
    "display_size_bytes" BIGINT NOT NULL,
    "quota_id" BIGINT NOT NULL,
    "reservation_id" BIGINT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "unreferenced_at" TIMESTAMPTZ(3),
    "storage_state" VARCHAR(15) NOT NULL,
    "is_attached" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Image_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" VARCHAR(64) NOT NULL,
    "account_id" BIGINT NOT NULL,
    "session_hash" VARCHAR(255) NOT NULL,
    "auth_version" INTEGER NOT NULL,
    "level" VARCHAR(15) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_active_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "is_revoked" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" BIGSERIAL NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "request_fingerprint" VARCHAR(64) NOT NULL,
    "account_id" BIGINT NOT NULL,
    "action" VARCHAR(50) NOT NULL,
    "object_type" VARCHAR(30) NOT NULL,
    "object_id" BIGINT NOT NULL,
    "result_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipientResponseHistory" (
    "id" BIGSERIAL NOT NULL,
    "recipient_id" BIGINT NOT NULL,
    "quote_id" BIGINT,
    "event_type" VARCHAR(30) NOT NULL,
    "prev_status" VARCHAR(15) NOT NULL,
    "new_status" VARCHAR(15) NOT NULL,
    "reason" TEXT,
    "quote_snapshot" JSONB,
    "performed_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecipientResponseHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalHistoryImage" (
    "history_id" BIGINT NOT NULL,
    "image_id" BIGINT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "JournalHistoryImage_pkey" PRIMARY KEY ("history_id","image_id")
);

-- CreateTable
CREATE TABLE "SecurityAuditLog" (
    "id" BIGSERIAL NOT NULL,
    "actor_id" BIGINT,
    "target_account_id" BIGINT NOT NULL,
    "event_type" VARCHAR(40) NOT NULL,
    "reason" TEXT,
    "verification_evidence" TEXT,
    "ip_address" VARCHAR(45),
    "auth_version_before" INTEGER,
    "auth_version_after" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorageQuota" (
    "id" BIGSERIAL NOT NULL,
    "workshop_id" BIGINT,
    "account_id" BIGINT,
    "initial_workshop_key" UUID,
    "limit_bytes" BIGINT NOT NULL,
    "used_bytes" BIGINT NOT NULL DEFAULT 0,
    "reserved_bytes" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StorageQuota_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadReservation" (
    "id" BIGSERIAL NOT NULL,
    "quota_id" BIGINT NOT NULL,
    "uploaded_by" BIGINT NOT NULL,
    "context_type" VARCHAR(30) NOT NULL,
    "context_id" BIGINT,
    "budget_bytes" BIGINT NOT NULL,
    "actual_bytes" BIGINT,
    "status" VARCHAR(20) NOT NULL,
    "storage_prefix" VARCHAR(255) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "UploadReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InitialWorkshopUploadScope" (
    "initial_workshop_key" UUID NOT NULL,
    "created_by" BIGINT NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'open',
    "attached_workshop_id" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "InitialWorkshopUploadScope_pkey" PRIMARY KEY ("initial_workshop_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_username_key" ON "Account"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Workshop_account_id_key" ON "Workshop"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "Certificate_image_id_key" ON "Certificate"("image_id");

-- CreateIndex
CREATE UNIQUE INDEX "Category_name_key" ON "Category"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Batch_qr_token_key" ON "Batch"("qr_token");

-- CreateIndex
CREATE UNIQUE INDEX "Batch_id_workshop_id_key" ON "Batch"("id", "workshop_id");

-- CreateIndex
CREATE INDEX "JournalEditHistory_journal_entry_id_edited_at_idx" ON "JournalEditHistory"("journal_entry_id", "edited_at");

-- CreateIndex
CREATE INDEX "QuoteRequest_buyer_id_created_at_idx" ON "QuoteRequest"("buyer_id", "created_at");

-- CreateIndex
CREATE INDEX "RequestRecipient_workshop_id_request_id_idx" ON "RequestRecipient"("workshop_id", "request_id");

-- CreateIndex
CREATE UNIQUE INDEX "RequestRecipient_request_id_workshop_id_key" ON "RequestRecipient"("request_id", "workshop_id");

-- CreateIndex
CREATE INDEX "Quote_request_id_status_bid_accept_deadline_idx" ON "Quote"("request_id", "status", "bid_accept_deadline");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_request_id_workshop_id_key" ON "Quote"("request_id", "workshop_id");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_id_request_id_workshop_id_key" ON "Quote"("id", "request_id", "workshop_id");

-- CreateIndex
CREATE UNIQUE INDEX "SplitProposal_id_request_id_key" ON "SplitProposal"("id", "request_id");

-- CreateIndex
CREATE UNIQUE INDEX "SplitProposalItem_proposal_id_workshop_id_key" ON "SplitProposalItem"("proposal_id", "workshop_id");

-- CreateIndex
CREATE UNIQUE INDEX "Allocation_quote_id_key" ON "Allocation"("quote_id");

-- CreateIndex
CREATE INDEX "Allocation_workshop_id_status_idx" ON "Allocation"("workshop_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Allocation_request_id_workshop_id_key" ON "Allocation"("request_id", "workshop_id");

-- CreateIndex
CREATE UNIQUE INDEX "Allocation_id_workshop_id_key" ON "Allocation"("id", "workshop_id");

-- CreateIndex
CREATE UNIQUE INDEX "Allocation_quote_id_request_id_workshop_id_key" ON "Allocation"("quote_id", "request_id", "workshop_id");

-- CreateIndex
CREATE UNIQUE INDEX "AllocationBatch_allocation_id_batch_id_key" ON "AllocationBatch"("allocation_id", "batch_id");

-- CreateIndex
CREATE INDEX "AllocationLog_allocation_id_created_at_idx" ON "AllocationLog"("allocation_id", "created_at");

-- CreateIndex
CREATE INDEX "StatusLog_request_id_created_at_idx" ON "StatusLog"("request_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "Image_storage_key_key" ON "Image"("storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "Image_thumbnail_key_key" ON "Image"("thumbnail_key");

-- CreateIndex
CREATE UNIQUE INDEX "Image_display_key_key" ON "Image"("display_key");

-- CreateIndex
CREATE UNIQUE INDEX "Image_reservation_id_key" ON "Image"("reservation_id");

-- CreateIndex
CREATE UNIQUE INDEX "Session_session_hash_key" ON "Session"("session_hash");

-- CreateIndex
CREATE INDEX "Session_expires_at_idx" ON "Session"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_account_id_action_object_type_object_id_i_key" ON "IdempotencyRecord"("account_id", "action", "object_type", "object_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "RecipientResponseHistory_recipient_id_created_at_idx" ON "RecipientResponseHistory"("recipient_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "JournalHistoryImage_history_id_position_key" ON "JournalHistoryImage"("history_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "StorageQuota_workshop_id_key" ON "StorageQuota"("workshop_id");

-- CreateIndex
CREATE UNIQUE INDEX "StorageQuota_account_id_key" ON "StorageQuota"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "StorageQuota_initial_workshop_key_key" ON "StorageQuota"("initial_workshop_key");

-- CreateIndex
CREATE UNIQUE INDEX "UploadReservation_storage_prefix_key" ON "UploadReservation"("storage_prefix");

-- CreateIndex
CREATE INDEX "UploadReservation_status_expires_at_idx" ON "UploadReservation"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "InitialWorkshopUploadScope_attached_workshop_id_key" ON "InitialWorkshopUploadScope"("attached_workshop_id");

-- AddForeignKey
ALTER TABLE "Workshop" ADD CONSTRAINT "Workshop_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Workshop" ADD CONSTRAINT "Workshop_avatar_image_id_fkey" FOREIGN KEY ("avatar_image_id") REFERENCES "Image"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "WorkshopStatusLog" ADD CONSTRAINT "WorkshopStatusLog_workshop_id_fkey" FOREIGN KEY ("workshop_id") REFERENCES "Workshop"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "WorkshopStatusLog" ADD CONSTRAINT "WorkshopStatusLog_performed_by_fkey" FOREIGN KEY ("performed_by") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_workshop_id_fkey" FOREIGN KEY ("workshop_id") REFERENCES "Workshop"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "Image"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_workshop_id_fkey" FOREIGN KEY ("workshop_id") REFERENCES "Workshop"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_batch_id_workshop_id_fkey" FOREIGN KEY ("batch_id", "workshop_id") REFERENCES "Batch"("id", "workshop_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_workshop_id_fkey" FOREIGN KEY ("workshop_id") REFERENCES "Workshop"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_performed_by_fkey" FOREIGN KEY ("performed_by") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "JournalEditHistory" ADD CONSTRAINT "JournalEditHistory_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "JournalEditHistory" ADD CONSTRAINT "JournalEditHistory_edited_by_fkey" FOREIGN KEY ("edited_by") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "NewsPost" ADD CONSTRAINT "NewsPost_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "NewsPost" ADD CONSTRAINT "NewsPost_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "QuoteRequest" ADD CONSTRAINT "QuoteRequest_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "QuoteRequest" ADD CONSTRAINT "QuoteRequest_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "QuoteRequest" ADD CONSTRAINT "QuoteRequest_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ContactEditHistory" ADD CONSTRAINT "ContactEditHistory_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "QuoteRequest"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ContactEditHistory" ADD CONSTRAINT "ContactEditHistory_edited_by_fkey" FOREIGN KEY ("edited_by") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "RequestRecipient" ADD CONSTRAINT "RequestRecipient_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "QuoteRequest"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "RequestRecipient" ADD CONSTRAINT "RequestRecipient_workshop_id_fkey" FOREIGN KEY ("workshop_id") REFERENCES "Workshop"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "RequestRecipient" ADD CONSTRAINT "RequestRecipient_responded_by_fkey" FOREIGN KEY ("responded_by") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "QuoteRequest"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_workshop_id_fkey" FOREIGN KEY ("workshop_id") REFERENCES "Workshop"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_withdrawn_by_fkey" FOREIGN KEY ("withdrawn_by") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_request_id_workshop_id_fkey" FOREIGN KEY ("request_id", "workshop_id") REFERENCES "RequestRecipient"("request_id", "workshop_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "SplitProposal" ADD CONSTRAINT "SplitProposal_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "QuoteRequest"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "SplitProposal" ADD CONSTRAINT "SplitProposal_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "SplitProposal" ADD CONSTRAINT "SplitProposal_rejected_by_fkey" FOREIGN KEY ("rejected_by") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "SplitProposalItem" ADD CONSTRAINT "SplitProposalItem_workshop_id_fkey" FOREIGN KEY ("workshop_id") REFERENCES "Workshop"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "SplitProposalItem" ADD CONSTRAINT "SplitProposalItem_proposal_id_request_id_fkey" FOREIGN KEY ("proposal_id", "request_id") REFERENCES "SplitProposal"("id", "request_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "SplitProposalItem" ADD CONSTRAINT "SplitProposalItem_quote_id_request_id_workshop_id_fkey" FOREIGN KEY ("quote_id", "request_id", "workshop_id") REFERENCES "Quote"("id", "request_id", "workshop_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Allocation" ADD CONSTRAINT "Allocation_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "QuoteRequest"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Allocation" ADD CONSTRAINT "Allocation_workshop_id_fkey" FOREIGN KEY ("workshop_id") REFERENCES "Workshop"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Allocation" ADD CONSTRAINT "Allocation_started_by_fkey" FOREIGN KEY ("started_by") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Allocation" ADD CONSTRAINT "Allocation_handed_over_by_fkey" FOREIGN KEY ("handed_over_by") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Allocation" ADD CONSTRAINT "Allocation_quote_id_request_id_workshop_id_fkey" FOREIGN KEY ("quote_id", "request_id", "workshop_id") REFERENCES "Quote"("id", "request_id", "workshop_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AllocationBatch" ADD CONSTRAINT "AllocationBatch_linked_by_fkey" FOREIGN KEY ("linked_by") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AllocationBatch" ADD CONSTRAINT "AllocationBatch_allocation_id_workshop_id_fkey" FOREIGN KEY ("allocation_id", "workshop_id") REFERENCES "Allocation"("id", "workshop_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AllocationBatch" ADD CONSTRAINT "AllocationBatch_batch_id_workshop_id_fkey" FOREIGN KEY ("batch_id", "workshop_id") REFERENCES "Batch"("id", "workshop_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AllocationLog" ADD CONSTRAINT "AllocationLog_allocation_id_fkey" FOREIGN KEY ("allocation_id") REFERENCES "Allocation"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AllocationLog" ADD CONSTRAINT "AllocationLog_performed_by_fkey" FOREIGN KEY ("performed_by") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "StatusLog" ADD CONSTRAINT "StatusLog_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "QuoteRequest"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "StatusLog" ADD CONSTRAINT "StatusLog_performed_by_fkey" FOREIGN KEY ("performed_by") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Image" ADD CONSTRAINT "Image_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Image" ADD CONSTRAINT "Image_quota_id_fkey" FOREIGN KEY ("quota_id") REFERENCES "StorageQuota"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Image" ADD CONSTRAINT "Image_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "UploadReservation"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "RecipientResponseHistory" ADD CONSTRAINT "RecipientResponseHistory_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "RequestRecipient"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "RecipientResponseHistory" ADD CONSTRAINT "RecipientResponseHistory_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "Quote"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "RecipientResponseHistory" ADD CONSTRAINT "RecipientResponseHistory_performed_by_fkey" FOREIGN KEY ("performed_by") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "JournalHistoryImage" ADD CONSTRAINT "JournalHistoryImage_history_id_fkey" FOREIGN KEY ("history_id") REFERENCES "JournalEditHistory"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "JournalHistoryImage" ADD CONSTRAINT "JournalHistoryImage_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "Image"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "SecurityAuditLog" ADD CONSTRAINT "SecurityAuditLog_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "SecurityAuditLog" ADD CONSTRAINT "SecurityAuditLog_target_account_id_fkey" FOREIGN KEY ("target_account_id") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "StorageQuota" ADD CONSTRAINT "StorageQuota_workshop_id_fkey" FOREIGN KEY ("workshop_id") REFERENCES "Workshop"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "StorageQuota" ADD CONSTRAINT "StorageQuota_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "StorageQuota" ADD CONSTRAINT "StorageQuota_initial_workshop_key_fkey" FOREIGN KEY ("initial_workshop_key") REFERENCES "InitialWorkshopUploadScope"("initial_workshop_key") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "UploadReservation" ADD CONSTRAINT "UploadReservation_quota_id_fkey" FOREIGN KEY ("quota_id") REFERENCES "StorageQuota"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "UploadReservation" ADD CONSTRAINT "UploadReservation_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "InitialWorkshopUploadScope" ADD CONSTRAINT "InitialWorkshopUploadScope_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "InitialWorkshopUploadScope" ADD CONSTRAINT "InitialWorkshopUploadScope_attached_workshop_id_fkey" FOREIGN KEY ("attached_workshop_id") REFERENCES "Workshop"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE UNIQUE INDEX "SplitProposal_one_proposed_per_request"
    ON "SplitProposal" ("request_id") WHERE status = 'proposed';

ALTER TABLE "Account"
    ADD CONSTRAINT "Account_role_check" CHECK (role IN ('buyer', 'artisan', 'admin')),
    ADD CONSTRAINT "Account_auth_version_positive_check" CHECK (auth_version > 0),
    ADD CONSTRAINT "Account_canonical_username_check" CHECK (username COLLATE "C" ~ '^[a-z0-9._]{4,32}$'),
    ADD CONSTRAINT "Account_buyer_profile_check" CHECK (role <> 'buyer' OR (COALESCE(btrim(display_name), '') <> '' AND COALESCE(btrim(phone), '') <> ''));

ALTER TABLE "Workshop"
    ADD CONSTRAINT "Workshop_status_check" CHECK (status IN ('active', 'suspended')),
    ADD CONSTRAINT "Workshop_coordinates_check" CHECK (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180);

ALTER TABLE "Product"
    ADD CONSTRAINT "Product_price_positive_check" CHECK (price > 0),
    ADD CONSTRAINT "Product_status_check" CHECK (status IN ('draft', 'published', 'hidden'));

ALTER TABLE "Batch"
    ADD CONSTRAINT "Batch_status_check" CHECK (status IN ('draft', 'published'));

ALTER TABLE "NewsPost"
    ADD CONSTRAINT "NewsPost_post_type_check" CHECK (post_type IN ('material', 'power_schedule', 'support_policy', 'announcement')),
    ADD CONSTRAINT "NewsPost_status_check" CHECK (status IN ('draft', 'published'));

ALTER TABLE "QuoteRequest"
    ADD CONSTRAINT "QuoteRequest_quantity_positive_check" CHECK (quantity > 0),
    ADD CONSTRAINT "QuoteRequest_unit_check" CHECK (unit IN ('piece', 'set')),
    ADD CONSTRAINT "QuoteRequest_status_check" CHECK (status IN ('draft_request', 'sent_to_artisans', 'artisans_bidding', 'buyer_accepted', 'in_production', 'delivered')),
    ADD CONSTRAINT "QuoteRequest_delivery_mode_check" CHECK (delivery_mode IN ('at_workshop', 'at_buyer_address')),
    ADD CONSTRAINT "QuoteRequest_version_positive_check" CHECK (version > 0),
    ADD CONSTRAINT "QuoteRequest_cancellation_check" CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL) AND (cancelled_at IS NULL OR status NOT IN ('draft_request', 'delivered'))),
    ADD CONSTRAINT "QuoteRequest_sent_fields_check" CHECK (status = 'draft_request' OR (
      category_id IS NOT NULL AND COALESCE(btrim(spec), '') <> ''
      AND quantity IS NOT NULL AND unit IS NOT NULL AND delivery_mode IS NOT NULL
      AND COALESCE(btrim(recipient_name), '') <> '' AND COALESCE(btrim(recipient_phone), '') <> ''
      AND bidding_deadline IS NOT NULL AND delivery_deadline IS NOT NULL
      AND delivery_deadline > bidding_deadline + INTERVAL '24 hours'
      AND (unit <> 'set' OR COALESCE(btrim(unit_set_description), '') <> '')
      AND (delivery_mode <> 'at_buyer_address' OR (
        COALESCE(btrim(delivery_region), '') <> '' AND COALESCE(btrim(delivery_address), '') <> ''
      ))
    ));

ALTER TABLE "ContactEditHistory"
    ADD CONSTRAINT "ContactEditHistory_version_positive_check" CHECK (version > 0);

ALTER TABLE "RequestRecipient"
    ADD CONSTRAINT "RequestRecipient_response_status_check" CHECK (response_status IN ('pending', 'declined', 'quoted', 'withdrawn')),
    ADD CONSTRAINT "RequestRecipient_version_positive_check" CHECK (version > 0);

ALTER TABLE "Quote"
    ADD CONSTRAINT "Quote_unit_price_positive_check" CHECK (unit_price > 0),
    ADD CONSTRAINT "Quote_max_quantity_positive_check" CHECK (max_quantity > 0),
    ADD CONSTRAINT "Quote_status_check" CHECK (status IN ('active', 'withdrawn', 'accepted')),
    ADD CONSTRAINT "Quote_version_positive_check" CHECK (version > 0),
    ADD CONSTRAINT "Quote_deadlines_check" CHECK (bid_accept_deadline < committed_delivery_at),
    ADD CONSTRAINT "Quote_withdrawal_check" CHECK (status <> 'withdrawn' OR (withdrawn_by IS NOT NULL AND withdrawn_at IS NOT NULL AND COALESCE(btrim(withdraw_reason), '') <> ''));

ALTER TABLE "SplitProposal"
    ADD CONSTRAINT "SplitProposal_status_check" CHECK (status IN ('proposed', 'accepted', 'expired')),
    ADD CONSTRAINT "SplitProposal_version_positive_check" CHECK (version > 0),
    ADD CONSTRAINT "SplitProposal_expire_reason_check" CHECK (expire_reason IN ('quote_changed', 'quote_withdrawn', 'quote_expired', 'workshop_suspended', 'replaced', 'buyer_rejected', 'request_accepted', 'request_cancelled')),
    ADD CONSTRAINT "SplitProposal_expiry_check" CHECK (status <> 'expired' OR (expired_at IS NOT NULL AND expire_reason IS NOT NULL));

ALTER TABLE "SplitProposalItem"
    ADD CONSTRAINT "SplitProposalItem_quote_version_positive_check" CHECK (quote_version > 0),
    ADD CONSTRAINT "SplitProposalItem_allocated_quantity_positive_check" CHECK (allocated_quantity > 0);

ALTER TABLE "Allocation"
    ADD CONSTRAINT "Allocation_quantity_positive_check" CHECK (quantity > 0),
    ADD CONSTRAINT "Allocation_unit_price_positive_check" CHECK (unit_price > 0),
    ADD CONSTRAINT "Allocation_status_check" CHECK (status IN ('not_started', 'in_production', 'handed_over')),
    ADD CONSTRAINT "Allocation_version_positive_check" CHECK (version > 0),
    ADD CONSTRAINT "Allocation_admin_handover_check" CHECK (NOT admin_handed_over OR (
      status = 'handed_over' AND handed_over_by IS NOT NULL AND handed_over_at IS NOT NULL
      AND admin_handover_actual_at IS NOT NULL AND COALESCE(btrim(admin_handover_reason), '') <> ''
      AND COALESCE(btrim(admin_delivery_evidence), '') <> ''
    ));

ALTER TABLE "AllocationBatch"
    ADD CONSTRAINT "AllocationBatch_linked_quantity_positive_check" CHECK (linked_quantity > 0);

ALTER TABLE "Image"
    ADD CONSTRAINT "Image_context_type_check" CHECK (context_type IN ('workshop_profile', 'certificate', 'product', 'journal_entry')),
    ADD CONSTRAINT "Image_width_positive_check" CHECK (width > 0),
    ADD CONSTRAINT "Image_height_positive_check" CHECK (height > 0),
    ADD CONSTRAINT "Image_storage_state_check" CHECK (storage_state IN ('ready', 'deleting')),
    ADD CONSTRAINT "Image_sizes_check" CHECK (original_size_bytes >= 0 AND thumbnail_size_bytes >= 0 AND display_size_bytes >= 0);

ALTER TABLE "Session"
    ADD CONSTRAINT "Session_auth_version_positive_check" CHECK (auth_version > 0),
    ADD CONSTRAINT "Session_level_check" CHECK (level IN ('normal', 'temp_password'));

ALTER TABLE "SecurityAuditLog"
    ADD CONSTRAINT "SecurityAuditLog_auth_version_before_positive_check" CHECK (auth_version_before > 0),
    ADD CONSTRAINT "SecurityAuditLog_auth_version_after_positive_check" CHECK (auth_version_after > 0);

ALTER TABLE "AllocationLog"
    ADD CONSTRAINT "AllocationLog_prev_status_check" CHECK (prev_status IN ('not_started', 'in_production', 'handed_over')),
    ADD CONSTRAINT "AllocationLog_new_status_check" CHECK (new_status IN ('not_started', 'in_production', 'handed_over')),
    ADD CONSTRAINT "AllocationLog_event_type_check" CHECK (event_type IN ('created', 'production_started', 'handover_recorded', 'handover_by_admin', 'batch_links_changed'));

ALTER TABLE "StatusLog"
    ADD CONSTRAINT "StatusLog_prev_status_check" CHECK (prev_status IN ('draft_request', 'sent_to_artisans', 'artisans_bidding', 'buyer_accepted', 'in_production', 'delivered')),
    ADD CONSTRAINT "StatusLog_new_status_check" CHECK (new_status IN ('draft_request', 'sent_to_artisans', 'artisans_bidding', 'buyer_accepted', 'in_production', 'delivered')),
    ADD CONSTRAINT "StatusLog_event_type_check" CHECK (event_type IN ('created', 'sent', 'first_quote', 'bidding_closed', 'split_requested', 'accepted', 'production_started', 'received_by_buyer', 'received_by_admin', 'cancelled'));

ALTER TABLE "RecipientResponseHistory"
    ADD CONSTRAINT "RecipientResponseHistory_prev_status_check" CHECK (prev_status IN ('pending', 'declined', 'quoted', 'withdrawn')),
    ADD CONSTRAINT "RecipientResponseHistory_new_status_check" CHECK (new_status IN ('pending', 'declined', 'quoted', 'withdrawn')),
    ADD CONSTRAINT "RecipientResponseHistory_event_type_check" CHECK (event_type IN ('declined', 'quote_submitted', 'quote_updated', 'quote_withdrawn', 'quote_resubmitted', 'quote_accepted'));

ALTER TABLE "WorkshopStatusLog"
    ADD CONSTRAINT "WorkshopStatusLog_prev_status_check" CHECK (prev_status IN ('active', 'suspended')),
    ADD CONSTRAINT "WorkshopStatusLog_new_status_check" CHECK (new_status IN ('active', 'suspended'));

ALTER TABLE "UploadReservation"
    ADD CONSTRAINT "UploadReservation_context_type_check" CHECK (context_type IN ('workshop_profile', 'certificate', 'product', 'journal_entry')),
    ADD CONSTRAINT "UploadReservation_status_check" CHECK (status IN ('reserved', 'committed', 'cleanup_pending', 'released')),
    ADD CONSTRAINT "UploadReservation_budget_check" CHECK (budget_bytes >= 0 AND (actual_bytes IS NULL OR actual_bytes BETWEEN 0 AND budget_bytes));

ALTER TABLE "InitialWorkshopUploadScope"
    ADD CONSTRAINT "InitialWorkshopUploadScope_status_check" CHECK (status IN ('open', 'attached', 'expired')),
    ADD CONSTRAINT "InitialWorkshopUploadScope_attached_check" CHECK ((status = 'attached') = (attached_workshop_id IS NOT NULL));

ALTER TABLE "JournalHistoryImage"
    ADD CONSTRAINT "JournalHistoryImage_position_check" CHECK (position >= 0);

ALTER TABLE "StorageQuota"
    ADD CONSTRAINT "StorageQuota_owner_check" CHECK (num_nonnulls(workshop_id, account_id, initial_workshop_key) = 1),
    ADD CONSTRAINT "StorageQuota_capacity_check" CHECK (limit_bytes >= 0 AND used_bytes >= 0 AND reserved_bytes >= 0 AND used_bytes <= limit_bytes - reserved_bytes);

COMMIT;
