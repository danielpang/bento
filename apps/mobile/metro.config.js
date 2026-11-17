const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// markdown-it (under react-native-markdown-display) requires Node's punycode,
// which React Native does not have. Point it at the npm package.
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  punycode: path.resolve(__dirname, 'node_modules/punycode'),
};

module.exports = config;
