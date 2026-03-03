import type { Metadata } from "next";
import { SuiProvider } from "@/providers/SuiProvider";
import { WorkerProvider } from "@/providers/WorkerProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Octopus",
  description: "On-Chain Confidential Transaction Omni-directional Privacy-enhanced Underlying Sui - Shield and unshield tokens with ZK proofs",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-cyber-dark-bg relative">
        {/* Octopus Background Image with Ocean Flow Effect */}
        <div
          className="fixed inset-0 z-0 animate-ocean-flow"
          style={{
            backgroundImage: "url('/images/octopus.jpg')",
            backgroundSize: "cover",
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
            opacity: 0.2,
          }}
        />

        {/* Dark overlay to blend background */}
        <div className="fixed inset-0 bg-gradient-to-b from-cyber-dark-bg/80 via-cyber-dark-bg/70 to-cyber-dark-bg/90 z-0" />

        {/* Center glow effect with purple accent */}
        <div
          className="fixed inset-0 pointer-events-none z-0"
          style={{
            background:
              "radial-gradient(circle at 50% 20%, rgba(0, 217, 255, 0.12) 0%, rgba(157, 0, 255, 0.08) 30%, transparent 60%)",
          }}
        />

        {/* Vignette effect */}
        <div className="fixed inset-0 bg-gradient-to-b from-transparent via-transparent to-black/50 pointer-events-none z-0" />

        {/* Purple accent glow corners */}
        <div
          className="fixed inset-0 pointer-events-none z-0"
          style={{
            background:
              "radial-gradient(circle at 0% 0%, rgba(157, 0, 255, 0.1) 0%, transparent 50%), radial-gradient(circle at 100% 100%, rgba(157, 0, 255, 0.1) 0%, transparent 50%)",
          }}
        />

        <div className="relative z-10">
          <WorkerProvider>
            <SuiProvider>{children}</SuiProvider>
          </WorkerProvider>
        </div>
      </body>
    </html>
  );
}
