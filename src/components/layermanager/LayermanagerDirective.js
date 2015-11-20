goog.provide('ga_layermanager_directive');

goog.require('ga_attribution_service');
goog.require('ga_layer_metadata_popup_service');
goog.require('ga_map_service');
goog.require('ga_urlutils_service');

(function() {

  var module = angular.module('ga_layermanager_directive', [
    'pascalprecht.translate',
    'ga_layer_metadata_popup_service',
    'ga_map_service',
    'ga_attribution_service',
    'ga_urlutils_service',
    'ngDraggable'
  ]);

  /**
   * Filter to display a correct time label in all possible situations
   */
  module.filter('gaTimeLabel', function($translate) {
    var maxYear = (new Date()).getFullYear();
    return function(input, layer) {
      // input values possible: 1978, '1978', '19783112', '99993112', undefined
      // if layer is WMTS:
      //   if timeselector not active:
      //      '99993112' ==> $translate.instant('all');
      //   else :
      //      undefined ==> '-'
      //      '19783112' ==> '1978'
      // if layer is WMS or others:
      //   if timeselector not active:
      //      undefined ==> ''
      //   else
      //      1978  ==> '1978'
      if (!input) {
        return (layer.getSource() instanceof ol.source.WMTS) ? '-' :
            $translate.instant('time_all');
      }
      var yearNum = input;
      if (angular.isString(input)) {
        yearNum = parseInt(input.substring(0, 4));
      }
      return (yearNum <= maxYear) ? yearNum : $translate.instant('time_all');
    }
  });

  module.directive('gaLayermanager', function($compile, $document, $timeout,
      $rootScope, $translate, $window, gaBrowserSniffer, gaLayerFilters,
      gaLayerMetadataPopup, gaLayers, gaAttribution, gaUrlUtils,
      gaMapUtils) {

    // Timestamps list template
    var tpl =
      '<div class="ga-layer-timestamps">' +
        '<div tabindex="1" ng-if="tmpLayer.type == \'wms\'" ' +
             'ng-class="{badge: !tmpLayer.time}" ' +
             'ng-click="setLayerTime(tmpLayer, null)" ' +
             'translate>time_all</div> ' +
        '<div tabindex="1" ng-repeat="i in tmpLayer.timestamps" ' +
             'ng-class="{badge: (tmpLayer.time == i)}" ' +
             'ng-click="setLayerTime(tmpLayer, i)">' +
          '{{i | gaTimeLabel:tmpLayer}}' +
        '</div>' +
      '</div>';

    // Create the popover
    var popover, content, container, callback, closeBt;
    var win = $($window);
    var createPopover = function(target, element, scope) {

      // Lazy load
      if (!container) {
        container = element.parent();
        callback = function(evt) {
          destroyPopover(evt.target, element);
        };
        closeBt = $('<button class="close">&times;</button>').on('click',
            function() {
          destroyPopover(null, element);
        });
      }

      popover = $(target).popover({
        container: container,
        content: content,
        html: 'true',
        placement: function() {
          return (win.width() < 640) ? 'left' : 'right';
        },
        title: $translate.instant('time_select_year'),
        trigger: 'manual'
      });
      popover.addClass('ga-layer-timestamps-popover');
      popover.popover('show');
      container.find('.popover-title').append(closeBt);
      element.on('scroll', callback);
      $document.on('click', callback);
      win.on('resize', callback);
    };

    // Remove the popover
    var destroyPopover = function(target, element) {
      if (popover) {
        if (target) {
          var popoverElt = container.find('.popover');
          if (popoverElt.is(target) ||
              popoverElt.has(target).length !== 0) {
            return;
          }
        }
        popover.popover('destroy');
        popover = undefined;
        element.unbind('scroll', callback);
        $document.unbind('click', callback);
        win.unbind('resize', callback);
      }
    };

    return {
      restrict: 'A',
      templateUrl: 'components/layermanager/partials/layermanager.html',
      scope: {
        map: '=gaLayermanagerMap'
      },
      link: function(scope, element, attrs) {
        var map = scope.map;
        var drag = {
          info: element.find('.drag-info'),
          upper: 'upper',
          under: 'under',
          scrollSpeed: 40,
          layerManager: element,
          element: null,
          position: {
            index: undefined,
            direction: undefined
          },
          previousClientY: undefined,
          ty: undefined
        };
        scope.mobile = gaBrowserSniffer.mobile;

        // Compile the time popover template
        content = $compile(tpl)(scope);

        // The ngRepeat collection is the map's array of layers. ngRepeat
        // uses $watchCollection internally. $watchCollection watches the
        // array, but does not shallow watch the array items! The array
        // items are OpenLayers layers, we don't want Angular to shallow
        // watch them.
        scope.layers = map.getLayers().getArray();
        scope.layerFilter = gaLayerFilters.selected;
        scope.mobile = gaBrowserSniffer.mobile;
        scope.$watchCollection('layers | filter:layerFilter', function(items) {
          scope.filteredLayers = (items) ? items.slice().reverse() : [];
        });

        // On mobile we use a classic select box, on desktop a popover
        if (!scope.mobile) {
          // Simulate a select box with a popover
          scope.displayTimestamps = function(evt, layer) {
            if (popover && popover[0] === evt.target) {
              destroyPopover(evt.target, element);
            } else {
              destroyPopover(evt.target, element);
              scope.tmpLayer = layer;
              // We use timeout otherwise the popover is bad centered.
              $timeout(function() {
                createPopover(evt.target, element, scope);
              }, 100, false);
            }
            evt.preventDefault();
            evt.stopPropagation();
          };
        } else {
          scope.displayTimestamps = function() {};
        }

        scope.isDefaultValue = function(timestamp) {
          if (timestamp && timestamp.length) {
            return (timestamp.substring(0, 4) === '9999') ? 'ga-black' : '';
          }
          return (!timestamp || timestamp === 9999) ? 'ga-black' : '';
        };

        var dupId = 0;
        scope.duplicateLayer = function(evt, layer) {
          var dupLayer = gaLayers.getOlLayerById(layer.bodId);
          dupLayer.time = layer.time;
          dupLayer.id = layer.id + '_' + dupId++;
          var index = scope.layers.indexOf(layer);
          map.getLayers().insertAt(index, dupLayer);
          evt.preventDefault();
        };

        scope.moveLayer = function(evt, layer, delta) {
          var index = scope.layers.indexOf(layer);
          var layersCollection = map.getLayers();
          layersCollection.removeAt(index);
          layersCollection.insertAt(index + delta, layer);
          evt.preventDefault();
        };

        scope.onDropComplete = function(evt) {
          var currentLayer = evt.data;
          var currentIndex = scope.filteredLayers.indexOf(currentLayer);
          if (drag.position.direction === drag.under &&
              currentIndex > drag.position.index) {
            drag.position.index++;
          } else if (drag.position.direction === drag.upper &&
              currentIndex < drag.position.index) {
            drag.position.index--;
          }

          if (drag.position.index < 0) {
            drag.position.index = 0;
          } else if (drag.position.index >= scope.layers.length) {
            drag.position.index = scope.layers.length - 1;
          }
          evt.event.stopPropagation();
          evt.event.preventDefault();
          if (currentLayer) {
            var layersCollection = map.getLayers();
            var index = scope.layers.indexOf(currentLayer);
            layersCollection.removeAt(index);
            var correctedIndex = scope.layers.length - drag.position.index;
            layersCollection.insertAt(correctedIndex, currentLayer);
          }
        };

        scope.onDragStart = function(evt) {
          // Drag start event is triggered twice. Once by the ngDrag directive
          // and once by the ngDrop directive here. This 'if' cancel the event
          // of the ngDrag directive.
          if (!evt.element && !evt.data) {
            return;
          }
          var target = evt.element;
          // Hide the tools if open
          if (!target.hasClass('ga-layer-folded')) {
            target.find('.icon-gear').click();
          }
          drag.layerManager.mousemove(function(evt) {
            updateDragInfo(evt);
          });
        };

        var updateDragInfo = function(evt) {
          if (drag.previousClientY) {
            drag.ty = evt.clientY - drag.previousClientY;
            drag.previousClientY = evt.clientY;
            var elt = drag.layerManager.find('.drag-enter:not(.dragging)');
            if (elt.length == 1 && drag.ty !== 0) {
              var elementPosition = elt.position().top - 5;
              drag.position.direction = (drag.ty > 0) ? drag.under : drag.upper;
              drag.position.index = drag.layerManager.find('li').index(elt[0]);
              if (drag.position.direction === drag.under) {
                 elementPosition += elt.height();
              }
              drag.info.css('top', elementPosition);
              drag.info.show();

              // Update scroll if necessary
              var margin = elt.height();
              var upperBound = drag.layerManager.offset().top;
              if (drag.position.direction == drag.under) {
                var lowerBound = upperBound + drag.layerManager.height();
                if (elt.offset().top > lowerBound - margin) {
                  drag.layerManager.scrollTop(drag.layerManager.scrollTop() +
                      drag.scrollSpeed);
                }
              } else if (drag.position.direction == drag.upper) {
                if (elt.offset().top < upperBound + margin) {
                  drag.layerManager.scrollTop(drag.layerManager.scrollTop() -
                      drag.scrollSpeed);
                }
              }
            }
          } else {
            drag.previousClientY = evt.clientY;
          }
        };

        scope.onDragStop = function(evt) {
          // Drag stop event is trigger twice. Once by the ngDrag directive and
          // once by the ngDrop directive here. This 'if' cancel the event of
          // the ngDrag directive.
          if (!evt.element && !evt.data) {
            return;
          }
          var target = evt.element;
          if (target) {
            drag.info.hide();
            drag.layerManager.off('mousemove');
            drag.previousClientY = undefined;
            drag.ty = undefined;
          }
        };

        scope.removeLayer = function(layer) {
          map.removeLayer(layer);
        };

        scope.isBodLayer = function(layer) {
          return layer.bodId && !!gaLayers.getLayer(layer.bodId);
        };

        scope.hasMetadata = function(layer) {
          return scope.isBodLayer(layer) ||
              gaMapUtils.isExternalWmsLayer(layer);
        };

        scope.showWarning = function(layer) {
          var url = gaUrlUtils.isValid(layer.url) ?
              gaUrlUtils.getHostname(layer.url) : layer.url;
          $window.alert($translate.instant('external_data_warning')
              .replace('--URL--', url));
        };

        scope.displayLayerMetadata = function(evt, layer) {
          gaLayerMetadataPopup.toggle(layer);
          evt.preventDefault();
        };

        scope.setLayerTime = function(layer, time) {
          if (angular.isDefined(time)) {
            layer.time = time;
          }
          destroyPopover(null, element);
        };

        scope.useRange = (!gaBrowserSniffer.mobile && (!gaBrowserSniffer.msie ||
            gaBrowserSniffer.msie > 9));

        if (!scope.useRange) {
          scope.opacityValues = [
            { key: '1' , value: '100%'},
            { key: '0.95' , value: '95%' }, { key: '0.9' , value: '90%' },
            { key: '0.85' , value: '85%' }, { key: '0.8' , value: '80%' },
            { key: '0.75' , value: '75%' }, { key: '0.7' , value: '70%' },
            { key: '0.65' , value: '65%' }, { key: '0.6' , value: '60%' },
            { key: '0.55' , value: '55%' }, { key: '0.5' , value: '50%' },
            { key: '0.45' , value: '45%' }, { key: '0.4' , value: '40%' },
            { key: '0.35' , value: '35%' }, { key: '0.3' , value: '30%' },
            { key: '0.25' , value: '25%' }, { key: '0.2' , value: '20%' },
            { key: '0.15' , value: '15%' }, { key: '0.1' , value: '10%' },
            { key: '0.05' , value: '5%' }, { key: '0' , value: '0%' }
          ];
        }

        // Toggle layer tools
        element.on('click', '.icon-gear', function() {
          var li = $(this).closest('li');
          li.toggleClass('ga-layer-folded');
          $(this).closest('ul').find('li').each(function(i, el) {
            if (el != li[0]) {
              $(el).addClass('ga-layer-folded');
            }
          });
        });


        if (!scope.mobile) {
          // Display the third party data tooltip
          element.tooltip({
            selector: '.icon-user',
            container: 'body',
            placement: 'right',
            title: function(elm) {
              return $translate.instant('external_data_tooltip');
            },
            template: '<div class="tooltip ga-red-tooltip" role="tooltip">' +
                '<div class="tooltip-arrow"></div><div class="tooltip-inner">' +
                '</div></div>'
          });
        }


        var removeNonTopicLayers = function(topicId) {
          // Assemble first to not remove from the iterated over array
          var layersToRemove = [];
          scope.map.getLayers().forEach(function(olLayer) {
            if (scope.isBodLayer(olLayer)) {
              var l = gaLayers.getLayer(olLayer.bodId);
              var regex = new RegExp('(^|,)(ech|' + topicId + ')(,|$)', 'g');
              if (l &&
                  l.topics &&
                  !regex.test(l.topics) &&
                  !olLayer.background) {
                layersToRemove.push(olLayer);
              }
            }
          });
          layersToRemove.forEach(function(olLayer) {
            scope.removeLayer(olLayer);
          });
        };

        // Remove non topic layer
        scope.$on('gaTopicChange', function(evt, newTopic) {
          removeNonTopicLayers(newTopic.id);
        });

        // Change layers label when topic changes
        scope.$on('gaLayersTranslationChange', function(evt) {
          map.getLayers().forEach(function(olLayer) {
            if (scope.isBodLayer(olLayer)) {
              olLayer.label = gaLayers.getLayerProperty(olLayer.bodId, 'label');
            }
          });
        });
      }
    };
  });
})();

