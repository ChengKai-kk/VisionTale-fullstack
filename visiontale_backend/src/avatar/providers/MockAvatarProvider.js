const { IAvatarProvider } = require("./IAvatarProvider");

class MockAvatarProvider extends IAvatarProvider {
  async stylize({ imageRef, styleId }) {
    const seed = encodeURIComponent(`${styleId}:${imageRef}`.slice(-80));
    return { avatarUrl: `https://picsum.photos/seed/${seed}/512/512` };
  }
}

module.exports = { MockAvatarProvider };
