var expect = module.exports = require('unexpected').clone().installPlugin(require('unexpected-jsdom')).installPlugin(require('unexpected-sinon')),
    URL = require('url');

expect.addAssertion('to contain [no] (asset|assets)', function (expect, subject, queryObj, number) {
    this.errorMode = 'nested';
    if (typeof queryObj === 'string') {
        queryObj = {type: queryObj};
    }
    if (this.flags.no) {
        number = 0;
    } else if (typeof number === 'undefined') {
        number = 1;
    }

    expect(subject.findAssets(queryObj), 'to have length', number);
});

expect.addAssertion('to contain (url|urls)', function (expect, subject, urls) {
    if (!Array.isArray(urls)) {
        urls = [urls];
    }
    urls = urls.map(function (url) {
        return URL.resolve(this.obj.root, url);
    }, this);
    this.errorMode = 'nested';
    urls.forEach(function (url) {
        expect(subject.findAssets({url: url}), 'to have length', 1);
    });
});

expect.addAssertion('to contain [no] (relation|relations)', function (expect, subject, queryObj, number) {
    if (typeof queryObj === 'string') {
        queryObj = {type: queryObj};
    }
    if (this.flags.no) {
        number = 0;
    } else if (typeof number === 'undefined') {
        number = 1;
    }
    this.errorMode = 'nested';
    expect(subject.findRelations(queryObj).length, 'to equal', number);
});

expect.addType({
    name: 'AssetGraph.Asset',
    base: 'object',
    identify: function (obj) {
        return obj && obj.isAsset;
    },
    equal: function (a, b) {
        return (
            a.type === b.type &&
            a.urlOrDescription === b.urlOrDescription &&
            (a.isText ? a.text : a.rawSrc) === (b.isText ? b.text : b.rawSrc)
            // && same outgoing relations
        );
    },
    inspect: function (asset, depth, output) {
        return output.text(asset.urlOrDescription);
    },
    toJSON: function (asset) {
        return {
            $Asset: {
                type: asset.type,
                urlOrDescription: asset.urlOrDescription,
                outgoingRelations: asset.outgoingRelations
            }
        };
    }
});

expect.addType({
    name: 'AssetGraph',
    base: 'object',
    identify: function (obj) {
        return obj && obj.isAssetGraph;
    },
    inspect: function (assetGraph, depth, output) {
        return output.text(['AssetGraph'].concat(assetGraph.findAssets({isInline: false}).map(function (asset) {
            return '  ' + (asset.isLoaded ? ' ' : '!') + ' ' + asset.urlOrDescription;
        }, this)).join('\n  '));
    },
    toJSON: function (assetGraph) {
        return {
            $AssetGraph: {
                assets: assetGraph.findAssets({isInline: false})
            }
        };
    }
});
