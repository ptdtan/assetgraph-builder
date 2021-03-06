var _ = require('lodash'),
    estraverse = require('estraverse'),
    esanimate = require('esanimate'),
    i18nTools = require('../i18nTools'),
    htmlLangCssSelectorRegExp = /(?:^|,\s*)(html\[\s*lang\s*(?:=|\|=|~=)\s*(|'|").*?\1\s*\])(.*)$/i;

function isLeftHandSideOfAssignment(stack, topNode) {
    function getItem(i) {
        if (i === stack.length) {
            return topNode;
        } else {
            return stack[i];
        }
    }
    for (var i = stack.length ; i >= 0 ; i -= 1) {
        var node = getItem(i);
        if (node.type === 'AssignmentExpression') {
            if (getItem(i + 1) === node.left) {
                return true;
            } else {
                break;
            }
        } else if (node.type === 'VariableDeclarator') {
            if (getItem(i + 1) === node.id.name) {
                return true;
            } else {
                break;
            }
        }
    }
    return false;
}

function assetNeedsLocalization(asset, assetGraph) {
    var needsLocalization = false;
    if (asset.type === 'JavaScript') {
        if (asset.incomingRelations.every(function (incomingRelation) {
            return incomingRelation.type !== 'HtmlScript' || incomingRelation.node.id !== 'bootstrapper';
        })) {
            estraverse.traverse(asset.parseTree, {
                enter: function (node) {
                    // TODO: The presence of only LOCALECOOKIENAME/SUPPORTEDLOCALEIDS/DEFAULTLOCALEID don't really require the asset to be cloned as
                    // they just need to be replaced to the same value in each locale.
                    if ((node.type === 'Identifier' && /^(?:LOCALEID|SUPPORTEDLOCALEIDS|DEFAULTLOCALEID|LOCALECOOKIENAME)$/.test(node.name) && !isLeftHandSideOfAssignment(this.parents(), node)) ||
                        (node.type === 'CallExpression' && node.callee.type === 'Identifier' &&
                         /^TR(?:PAT)?$/.test(node.callee.name))) {

                        needsLocalization = true;
                        return this.break();
                    }
                }
            });
        }
    } else if (asset.isHtml || asset.isSvg) {
        i18nTools.eachI18nTagInHtmlDocument(asset.parseTree, function (options) {
            if (options.key !== null) {
                needsLocalization = true;
                return false;
            }
        });
    } else if (asset.type === 'Css') {
        asset.eachRuleInParseTree(function (cssRule, parentRuleOrStylesheet) {
            if (cssRule.type === 'rule') {
                if (htmlLangCssSelectorRegExp.test(cssRule.selector)) {
                    needsLocalization = true;
                    return false;
                }
            }
        });
    }
    return needsLocalization;
}

function isBootstrapperRelation(relation) {
    return relation.type === 'HtmlScript' && relation.node && relation.node.getAttribute('id') === 'bootstrapper';
}

function followRelationFn(relation) {
    return relation.type !== 'HtmlAnchor' && relation.type !== 'HtmlMetaRefresh' && relation.type !== 'SvgAnchor' && relation.type !== 'JavaScriptSourceUrl' && !isBootstrapperRelation(relation);
}

module.exports = function (queryObj, options) {
    var localeIds = options.localeIds.map(i18nTools.normalizeLocaleId),
        defaultLocaleId = i18nTools.normalizeLocaleId(options.defaultLocaleId || 'en');

    return function cloneForEachLocale(assetGraph) {
        assetGraph.findAssets(_.extend({type: 'Html'}, queryObj)).forEach(function (originalHtmlAsset) {
            var assetToLocalizeById = {},
                assetsToLocalize = [];
            assetGraph.eachAssetPostOrder(originalHtmlAsset, followRelationFn, function (asset) {
                if (asset.isLoaded && (assetNeedsLocalization(asset) || assetGraph.findRelations({from: asset}).some(function (outgoingRelation) {return outgoingRelation.to.id in assetToLocalizeById;}))) {
                    assetToLocalizeById[asset.id] = asset;
                    assetsToLocalize.push(asset);
                }
            });

            var nonInlineAssetsToLocalizePreOrder = [];
            assetGraph.eachAssetPreOrder(originalHtmlAsset, followRelationFn, function (asset) {
                if (!asset.isInline && asset.id in assetToLocalizeById) {
                    nonInlineAssetsToLocalizePreOrder.push(asset);
                }
            });

            localeIds.forEach(function (localeId) {
                var allKeysForLocale = i18nTools.extractAllKeysForLocale(assetGraph, localeId),
                    trReplacer = i18nTools.createTrReplacer({
                        allKeysForLocale: allKeysForLocale,
                        localeId: localeId,
                        defaultLocaleId: defaultLocaleId
                    }),
                    i18nTagReplacer = i18nTools.createI18nTagReplacer({
                        allKeysForLocale: allKeysForLocale,
                        localeId: localeId,
                        defaultLocaleId: defaultLocaleId
                    }),
                    globalValueByName = {LOCALEID: localeId, SUPPORTEDLOCALEIDS: localeIds, DEFAULTLOCALEID: defaultLocaleId};

                ['localeCookieName'].forEach(function (optionName) {
                    if (options[optionName]) {
                        globalValueByName[optionName.toUpperCase()] = options[optionName];
                    }
                });

                var localizedAssets = [];

                function localizeAsset(asset) {
                    if (asset.type === 'JavaScript') {
                        if (asset.incomingRelations.every(isBootstrapperRelation)) {
                            return;
                        }
                        i18nTools.eachTrInAst(asset.parseTree, trReplacer);

                        estraverse.replace(asset.parseTree, {
                            enter: function (node) {
                                if (node.type === 'Identifier' && globalValueByName.hasOwnProperty(node.name) && !isLeftHandSideOfAssignment(this.parents(), node)) {
                                    return esanimate.astify(globalValueByName[node.name]);
                                }
                            }
                        });
                        asset.markDirty();
                    } else if (asset.isHtml || asset.isSvg) {
                        var document = asset.parseTree;
                        i18nTools.eachI18nTagInHtmlDocument(document, i18nTagReplacer);
                        if (document.documentElement) {
                            document.documentElement.setAttribute('lang', localeId);
                        }
                        asset.markDirty();
                    } else if (asset.type === 'Css') {
                        var cssRules = [];
                        asset.eachRuleInParseTree(function (cssRule) {
                            if (cssRule.type === 'rule') {
                                cssRules.push(cssRule);
                            }
                        });
                        // Traverse the rules in reverse so the indices aren't screwed up by deleting rules underway:
                        cssRules.reverse().forEach(function (node) {
                            var matchSelectorText = node.selector.match(htmlLangCssSelectorRegExp);
                            if (matchSelectorText) {
                                var rewrittenSelectorFragments = [];

                                node.selector.split(/\s*,\s*/).forEach(function (selectorFragment) {
                                    var matchSelectorFragment = selectorFragment.match(/(html\[\s*lang\s*(?:=|\|=|~=)\s*(|'|").*?\1\s*\])(.*)$/i);
                                    if (matchSelectorFragment) {
                                        if (localizedAssets[0].parseTree.querySelectorAll(matchSelectorFragment[1]).length > 0) {
                                            rewrittenSelectorFragments.push('html' + matchSelectorFragment[3]);
                                        }
                                    } else {
                                        rewrittenSelectorFragments.push(selectorFragment);
                                    }
                                });
                                if (rewrittenSelectorFragments.length > 0) {
                                    node.selector = rewrittenSelectorFragments.join(', ');
                                } else {
                                    assetGraph.findRelations({from: asset}).forEach(function (outgoingRelation) {
                                        if (outgoingRelation.node !== node) {
                                            return;
                                        }
                                        if (outgoingRelation.to.isInline) {
                                            assetGraph.removeAsset(outgoingRelation.to);
                                        }
                                        // FIXME: Find out why outgoingRelation isn't in the graph when outgoingRelation.to is an inline image!
                                        if (outgoingRelation.assetGraph) {
                                            assetGraph.removeRelation(outgoingRelation);
                                        }
                                    });
                                    node.parent.removeChild(node);
                                }
                            }
                        });
                        asset.markDirty();
                    }
                }

                // asset.clone adds the asset to the graph and populates the relations. Since the localization
                // could introduce or remove relations, it needs to happen before the population.
                // The 'addAsset' event is emitted right before the population takes place, so that does the job.
                // (Would of course be cleaner if asset.clone was split up or supported a hook at this point).
                assetGraph.on('addAsset', localizeAsset);

                nonInlineAssetsToLocalizePreOrder.forEach(function (asset) {
                    var incomingRelationsFromLocalizedAssets = assetGraph.findRelations({to: asset, from: {nonInlineAncestor: localizedAssets}}),
                        targetUrl = asset.url.replace(/(\.\w+)?$/, '.' + localeId + '$1'),
                        existingLocalizedAsset = assetGraph.findAssets({url: targetUrl})[0];

                    if (existingLocalizedAsset) {
                        incomingRelationsFromLocalizedAssets.forEach(function (incomingRelation) {
                            incomingRelation.to = existingLocalizedAsset;
                            incomingRelation.refreshHref();
                        });
                    } else {
                        var localizedAsset = asset.clone(incomingRelationsFromLocalizedAssets);
                        localizedAsset.url = targetUrl;
                        localizedAssets.push(localizedAsset);
                    }
                });

                assetGraph.removeListener('addAsset', localizeAsset);
            });

            // Remove orphaned JavaScript and templates:

            nonInlineAssetsToLocalizePreOrder.forEach(function (asset) {
                if (asset.assetGraph && (asset === originalHtmlAsset || (!asset.isInline && assetGraph.findRelations({to: asset}).length === 0))) {
                    assetGraph.removeAsset(asset);
                }
            });
        });
    };
};
