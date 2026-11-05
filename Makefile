# RO-IPTV — build & local security scanning (§5)
# Scans are strict: missing tools and scanner failures both fail the gate.

IMAGE_TAG  ?= ro-iptv:latest
DOCKERFILE ?= Dockerfile
SBOM       ?= sbom.spdx.json

# ---- Publish (GitHub Container Registry) ----------------------------------
# End users never build — they pull a ready image. Published for linux/amd64
# only; arm64 was dropped after 1.3.0.
REGISTRY   ?= ghcr.io
OWNER      ?= aiulian25
IMAGE      ?= $(REGISTRY)/$(OWNER)/ro-iptv
VERSION    ?= latest
PLATFORMS  ?= linux/amd64
BUILDER    ?= multiarch

.PHONY: help build deploy up down logs scan hadolint trivy grype sbom clean-scan login buildx-init release release-check

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

build: ## Build the single-image container
	docker build -t $(IMAGE_TAG) -f $(DOCKERFILE) .

deploy: ## Pull the published image and start (no build)
	docker compose up -d

up: ## Build from source and (re)start the local image
	docker compose -f docker-compose.build.yml up -d --build

down: ## Stop the stack
	docker compose down

logs: ## Tail container logs
	docker compose logs -f --tail=100

# ---- Multi-arch release ---------------------------------------------------
login: ## Log in to GHCR using the gh CLI token
	@gh auth token | docker login $(REGISTRY) -u $(OWNER) --password-stdin

# buildx is still what pushes (it carries the labels and writes the manifest),
# but no QEMU: emulation was only ever needed for the arm64 build.
buildx-init: ## Ensure the buildx builder used for publishing exists
	@docker buildx inspect $(BUILDER) >/dev/null 2>&1 || docker buildx create --name $(BUILDER) --driver docker-container --use

# Build and push linux/amd64. Pass VERSION=x.y.z to also stamp a version tag
# alongside :latest, e.g. `make release VERSION=1.2.0`.
#
# This is the only way images are published — there is no CI build. Add an arch
# back by extending PLATFORMS; the $BUILDPLATFORM pins in the Dockerfile are what
# keep that from re-running npm install under QEMU, which is what hung the old
# GitHub Actions job indefinitely.
REVISION := $(shell git rev-parse HEAD)
CREATED  := $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
# 1.2.0 -> 1.2, so pulls can float on the minor series. Empty for VERSION=latest.
MINOR    := $(shell echo $(VERSION) | grep -oE '^[0-9]+\.[0-9]+')

release-check: build ## Build the local candidate and require all security checks
	$(MAKE) scan

release: release-check ## Scan, then build + push the image to GHCR (linux/amd64)
	$(MAKE) login buildx-init
	docker buildx build --builder $(BUILDER) --platform $(PLATFORMS) \
	  -t $(IMAGE):$(VERSION) \
	  $(if $(MINOR),-t $(IMAGE):$(MINOR),) \
	  $(if $(filter-out latest,$(VERSION)),-t $(IMAGE):latest,) \
	  --label "org.opencontainers.image.revision=$(REVISION)" \
	  --label "org.opencontainers.image.version=$(VERSION)" \
	  --label "org.opencontainers.image.created=$(CREATED)" \
	  --push -f $(DOCKERFILE) .
	@echo "✓ pushed $(IMAGE):$(VERSION) $(if $(MINOR),+ :$(MINOR),) + :latest ($(PLATFORMS))"

# ---- Security scanning ----------------------------------------------------
scan: hadolint trivy grype sbom ## Run the full local scan suite (after build)
	@echo "✓ scan suite complete"

hadolint: ## Lint the Dockerfile (hadolint)
	@command -v hadolint >/dev/null 2>&1 || { echo 'error: required scanner hadolint is not installed' >&2; exit 1; }
	hadolint "$(DOCKERFILE)" --ignore DL3018 --ignore DL3008

trivy: ## Scan image for OS + dependency CVEs (fail on fixable HIGH/CRITICAL)
	@command -v trivy >/dev/null 2>&1 || { echo 'error: required scanner trivy is not installed' >&2; exit 1; }
	trivy image --exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed "$(IMAGE_TAG)"

# --only-fixed matches trivy's policy above: block on anything a rebuild can
# actually clear. Alpine regularly carries High/Critical CVEs with no patched
# package (ffmpeg, glib, cjson at the time of writing); failing on those would
# block every release on upstream's schedule without changing what ships. They
# are picked up automatically the moment a fixed version exists.
grype: ## Scan image for vulnerabilities (fail on fixable high)
	@command -v grype >/dev/null 2>&1 || { echo 'error: required scanner grype is not installed' >&2; exit 1; }
	grype "$(IMAGE_TAG)" --fail-on high --only-fixed

sbom: ## Generate an SPDX SBOM (syft); preserve the previous artifact on failure
	@command -v syft >/dev/null 2>&1 || { echo 'error: required scanner syft is not installed' >&2; exit 1; }
	@set -eu; \
	  tmp=$$(mktemp "$(SBOM).tmp.XXXXXX"); \
	  trap 'rm -f "$$tmp"' EXIT HUP INT TERM; \
	  syft "$(IMAGE_TAG)" -o spdx-json > "$$tmp"; \
	  mv -f "$$tmp" "$(SBOM)"; \
	  echo "SBOM → $(SBOM)"

clean-scan: ## Remove generated SBOM
	rm -f "$(SBOM)"
