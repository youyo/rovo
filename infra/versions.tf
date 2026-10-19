terraform {
  required_version = ">= 1.9"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.27.0"
    }
  }
}

# トークンは env の CLOUDFLARE_API_TOKEN から読む。
provider "cloudflare" {}
