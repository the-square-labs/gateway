CREATE TABLE "gateway_diagnostics_samples" (
	"minute" timestamp with time zone PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL
);
