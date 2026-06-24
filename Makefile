# RO-IPTV — build & local security scanning (§5)
# Each scanner is optional: if a tool isn't installed the step is skipped with a
# hint instead of failing, so `make scan` works on any machine.

IMAGE_TAG  ?= ro-iptv:latest
DOCKERFILE ?= Dockerfile
SBOM       ?= sbom.spdx.json

# ---- Multi-arch publish (GitHub Container Registry) -----------------------
# End users never build — they pull a ready multi-arch image. The only variable
# on their side (amd64 vs arm64) is resolved automatically by the manifest list.
REGISTRY   ?= ghcr.io
OWNER      ?= aiulian25
IMAGE      ?= $(REGISTRY)/$(OWNER)/ro-iptv
VERSION    ?= latest
PLATFORMS  ?= linux/amd64,linux/arm64
BUILDER    ?= multiarch

.PHONY: help build deploy up down logs scan hadolint trivy grype sbom clean-scan login buildx-init release

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

buildx-init: ## Ensure a multi-arch buildx builder + qemu emulation exist
	@docker buildx inspect $(BUILDER) >/dev/null 2>&1 || docker buildx create --name $(BUILDER) --driver docker-container --use
	@docker run --privileged --rm tonistiigi/binfmt --install all >/dev/null 2>&1 || true

# Build BOTH arches and push a single manifest list. Pass VERSION=x.y.z to also
# stamp a version tag alongside :latest, e.g. `make release VERSION=1.1.0`.
release: login buildx-init ## Build + push multi-arch image to GHCR (amd64 + arm64)
	docker buildx build --builder $(BUILDER) --platform $(PLATFORMS) \
	  -t $(IMAGE):$(VERSION) $(if $(filter-out latest,$(VERSION)),-t $(IMAGE):latest,) \
	  --push -f $(DOCKERFILE) .
	@echo "✓ pushed $(IMAGE):$(VERSION) ($(PLATFORMS))"

# ---- Security scanning ----------------------------------------------------
scan: hadolint trivy grype sbom ## Run the full local scan suite (after build)
	@echo "✓ scan suite complete"

hadolint: ## Lint the Dockerfile (hadolint)
	@command -v hadolint >/dev/null 2>&1 && { \
	  echo '== hadolint =='; \
	  hadolint $(DOCKERFILE) --ignore DL3018 --ignore DL3008 ; \
	} || echo 'skip hadolint — not installed (https://github.com/hadolint/hadolint)'

trivy: ## Scan image for OS + dependency CVEs (fail on fixable HIGH/CRITICAL)
	@command -v trivy >/dev/null 2>&1 && { \
	  echo '== trivy =='; \
	  trivy image --exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed $(IMAGE_TAG) ; \
	} || echo 'skip trivy — not installed (https://aquasecurity.github.io/trivy)'

grype: ## Scan image for vulnerabilities (fail on high)
	@command -v grype >/dev/null 2>&1 && { \
	  echo '== grype =='; \
	  grype $(IMAGE_TAG) --fail-on high ; \
	} || echo 'skip grype — not installed (https://github.com/anchore/grype)'

sbom: ## Generate an SPDX SBOM (syft)
	@command -v syft >/dev/null 2>&1 && { \
	  echo '== syft SBOM =='; \
	  syft $(IMAGE_TAG) -o spdx-json > $(SBOM) && echo "SBOM → $(SBOM)" ; \
	} || echo 'skip syft — not installed (https://github.com/anchore/syft)'

clean-scan: ## Remove generated SBOM
	rm -f $(SBOM)
