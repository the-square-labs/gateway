import { motion } from "framer-motion";

export function PoweredByFooter({ transitionKey }: { transitionKey: string }) {
  return (
    <motion.p
      key={transitionKey}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
      className="text-center text-xs text-muted-foreground"
    >
      Powered by{" "}
      <a
        href="https://wiolett.net"
        target="_blank"
        rel="noopener noreferrer"
        className="text-foreground hover:underline"
      >
        Wiolett Industries
      </a>
    </motion.p>
  );
}
