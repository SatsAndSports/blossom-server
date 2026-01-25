# Blossom Server Makefile
#
# Usage:
#   make test       # Run tests (without rebuilding WASM)
#   make test-full  # Build WASM (fast) and run tests
#   make wasm-dev   # Fast WASM build (~1s) - skips wasm-opt
#   make wasm       # Optimized WASM build (~16s) - for production
#   make build      # Build the TypeScript project
#   make dev        # Start development server with hot reload
#   make clean      # Remove local WASM copies (preserves .gitignore)
#
# For video encoding/uploading, see tools/hls-*.sh

.PHONY: test test-full wasm wasm-dev build dev clean .check-cdk-repo

# Default target: run tests without rebuilding WASM
test:
	npm test

# Full test: fast WASM rebuild then run tests
test-full: wasm-dev
	npm test

# Build the TypeScript project
build:
	npm run build

# Start development server
dev:
	npm run dev

# --- WASM Build Targets ---
# Build via parent CDK Makefile, then copy to local directories

WASM_WEB_SRC := ../wasm-web
WASM_WEB_DEST := public/wasm
WASM_NODEJS_SRC := ../wasm-nodejs
WASM_NODEJS_DEST := src/wasm
WASM_FILES := cdk_wasm.js cdk_wasm.d.ts cdk_wasm_bg.wasm cdk_wasm_bg.wasm.d.ts package.json

# Check we're inside the CDK repo
.check-cdk-repo:
	@if [ ! -f ../../crates/cdk-wasm/Cargo.toml ]; then \
		echo ""; \
		echo "ERROR: blossom-server must be inside the CDK repo to build WASM."; \
		echo "Expected to find ../../crates/cdk-wasm/Cargo.toml"; \
		echo ""; \
		echo "If running blossom-server standalone, copy pre-built WASM files to:"; \
		echo "  $(WASM_WEB_DEST)/"; \
		echo "  $(WASM_NODEJS_DEST)/"; \
		echo ""; \
		exit 1; \
	fi

# Fast development WASM build (skips wasm-opt, ~1s)
wasm-dev: .check-cdk-repo
	$(MAKE) -C ../.. wasm-dev
	@mkdir -p $(WASM_WEB_DEST) $(WASM_NODEJS_DEST)
	cp $(addprefix $(WASM_WEB_SRC)/,$(WASM_FILES)) $(WASM_WEB_DEST)/
	cp $(addprefix $(WASM_NODEJS_SRC)/,$(WASM_FILES)) $(WASM_NODEJS_DEST)/
	@echo "WASM copied to blossom-server"

# Optimized release WASM build (~16s)
wasm: .check-cdk-repo
	$(MAKE) -C ../.. wasm
	@mkdir -p $(WASM_WEB_DEST) $(WASM_NODEJS_DEST)
	cp $(addprefix $(WASM_WEB_SRC)/,$(WASM_FILES)) $(WASM_WEB_DEST)/
	cp $(addprefix $(WASM_NODEJS_SRC)/,$(WASM_FILES)) $(WASM_NODEJS_DEST)/
	@echo "WASM copied to blossom-server"

# Clean local WASM copies (preserves .gitignore files)
clean:
	find $(WASM_WEB_DEST) $(WASM_NODEJS_DEST) -type f ! -name '.gitignore' -delete 2>/dev/null || true
	@echo "Local WASM copies cleaned"
