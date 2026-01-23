# Blossom Server Makefile
#
# Usage:
#   make test       # Run tests (without rebuilding WASM)
#   make test-full  # Build WASM (fast) and run tests
#   make wasm-dev   # Fast WASM build (~1s) - skips wasm-opt
#   make wasm       # Optimized WASM build (~16s) - for production
#   make build      # Build the TypeScript project
#   make dev        # Start development server with hot reload
#   make clean      # Remove WASM build artifacts (preserves .gitignore)
#
# For video encoding/uploading, see tools/hls-*.sh

.PHONY: test test-full wasm wasm-dev wasm-web wasm-nodejs wasm-web-dev wasm-nodejs-dev build dev clean

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

WASM_WEB_SRC := ../wasm-web
WASM_WEB_DEST := public/wasm
WASM_NODEJS_SRC := ../wasm-nodejs
WASM_NODEJS_DEST := src/wasm
WASM_FILES := cdk_wasm.js cdk_wasm.d.ts cdk_wasm_bg.wasm cdk_wasm_bg.wasm.d.ts package.json

# Fast development WASM build (skips wasm-opt, ~1s)
wasm-dev: wasm-web-dev wasm-nodejs-dev
	@echo "WASM dev build complete (no optimization)"

# Optimized release WASM build (~16s)
wasm: wasm-web wasm-nodejs
	@echo "WASM release build complete"

# Browser WASM - fast dev build
wasm-web-dev:
	cd ../../crates/cdk-wasm && wasm-pack build --release --no-opt --target web --out-dir ../../web/wasm-web
	@mkdir -p $(WASM_WEB_DEST)
	cp $(addprefix $(WASM_WEB_SRC)/,$(WASM_FILES)) $(WASM_WEB_DEST)/
	@echo "Browser WASM (dev) copied to $(WASM_WEB_DEST)/"

# Browser WASM - optimized release build
wasm-web:
	cd ../../crates/cdk-wasm && wasm-pack build --release --target web --out-dir ../../web/wasm-web
	@mkdir -p $(WASM_WEB_DEST)
	cp $(addprefix $(WASM_WEB_SRC)/,$(WASM_FILES)) $(WASM_WEB_DEST)/
	@echo "Browser WASM (release) copied to $(WASM_WEB_DEST)/"

# Node.js WASM - fast dev build
wasm-nodejs-dev:
	cd ../../crates/cdk-wasm && wasm-pack build --release --no-opt --target nodejs --out-dir ../../web/wasm-nodejs
	@mkdir -p $(WASM_NODEJS_DEST)
	cp $(addprefix $(WASM_NODEJS_SRC)/,$(WASM_FILES)) $(WASM_NODEJS_DEST)/
	@echo "Node.js WASM (dev) copied to $(WASM_NODEJS_DEST)/"

# Node.js WASM - optimized release build
wasm-nodejs:
	cd ../../crates/cdk-wasm && wasm-pack build --release --target nodejs --out-dir ../../web/wasm-nodejs
	@mkdir -p $(WASM_NODEJS_DEST)
	cp $(addprefix $(WASM_NODEJS_SRC)/,$(WASM_FILES)) $(WASM_NODEJS_DEST)/
	@echo "Node.js WASM (release) copied to $(WASM_NODEJS_DEST)/"

# Clean WASM build artifacts (preserves .gitignore files)
clean:
	rm -rf ../wasm-web ../wasm-nodejs
	find $(WASM_WEB_DEST) $(WASM_NODEJS_DEST) -type f ! -name '.gitignore' -delete 2>/dev/null || true
	@echo "WASM directories cleaned"
