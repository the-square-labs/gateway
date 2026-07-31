import { CheckCircle } from "lucide-react";
import { CopyValueField } from "@/components/common/CopyValueField";
import { PanelShell } from "@/components/common/PanelShell";
import { SectionHeader } from "@/components/common/SectionHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { DNSChallenge } from "@/types";

interface DNSChallengeVerificationProps {
  challenges: DNSChallenge[];
  onVerify: () => void;
  isVerifying: boolean;
  title?: string;
  description?: string;
  verifyLabel?: string;
  showAction?: boolean;
}

export function DNSChallengeVerification({
  challenges,
  onVerify,
  isVerifying,
  title = "DNS Challenge Records",
  description = "Add the following DNS TXT records to verify domain ownership, then click Verify.",
  verifyLabel = "Verify DNS",
  showAction = true,
}: DNSChallengeVerificationProps) {
  return (
    <div className="space-y-4">
      <PanelShell
        title={
          <span className="flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-warning" />
            {title}
          </span>
        }
        description={description}
        bodyClassName="divide-y divide-border"
      >
        {challenges.map((challenge, i) => (
          <div key={`${challenge.domain}-${i}`}>
            <SectionHeader
              title={
                <span className="block min-w-0 truncate" title={challenge.domain}>
                  {challenge.domain}
                </span>
              }
              description="Domain"
              actions={
                <Badge variant="secondary" className="shrink-0 font-mono">
                  TXT
                </Badge>
              }
              className="bg-muted/40 px-3 py-2 dark:bg-muted/60"
              titleClassName="min-w-0 truncate text-sm"
              descriptionClassName="uppercase"
            />
            <div className="space-y-3 p-3">
              <CopyValueField label="Record name" value={challenge.recordName} />
              <CopyValueField label="Record value" value={challenge.recordValue} />
            </div>
          </div>
        ))}
      </PanelShell>
      {showAction && (
        <Button onClick={onVerify} disabled={isVerifying}>
          {isVerifying ? "Verifying..." : verifyLabel}
        </Button>
      )}
    </div>
  );
}
