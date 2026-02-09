export function Footer() {
  return (
    <footer className="mt-16 border-t-2 border-gray-900 py-8 relative">
      <div className="absolute inset-0 bg-gradient-to-t from-cyber-dark-bg to-transparent opacity-50" />
      <div className="mx-auto max-w-6xl px-4 text-center relative z-10">
        <div className="flex items-center justify-center gap-3 mb-3">
          <div className="h-px w-16 bg-gradient-to-r from-transparent to-cyber-blue/50" />
          <span className="text-xs text-gray-600 font-mono tracking-widest uppercase">OCTOPUS</span>
          <div className="h-px w-16 bg-gradient-to-l from-transparent to-cyber-blue/50" />
        </div>
        <p className="text-xs text-gray-500 font-mono">
          Built with Octopus privacy protocol on Sui •{" "}
          <a
            href="https://github.com/june-in-exile/Octopus"
            className="text-cyber-blue hover:text-cyber-blue/80 transition-colors"
            target="_blank"
            rel="noopener noreferrer"
          >
            [SOURCE_CODE]
          </a>
        </p>
      </div>
    </footer>
  );
}
