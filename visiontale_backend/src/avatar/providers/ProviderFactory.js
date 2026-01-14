const { MockAvatarProvider } = require("./MockAvatarProvider");
const { DoubaoArkProvider } = require("./DoubaoArkProvider");

class ProviderFactory {
  constructor() {
    this.providers = {
      mock: new MockAvatarProvider(),
      doubao: new DoubaoArkProvider()
    };
  }

  get(name) {
    return this.providers[name] || this.providers.doubao;
  }
}

module.exports = { ProviderFactory };
