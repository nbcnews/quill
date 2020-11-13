import Parchment from 'parchment';
import clone from 'clone';
import equal from 'deep-equal';
import Emitter from './emitter';
import logger from './logger';

let debug = logger('quill:selection');


class Range {
  constructor(index, length = 0) {
    this.index = index;
    this.length = length;
  }
}


class Selection {
  constructor(scroll, emitter) {
    this.emitter = emitter;
    this.scroll = scroll;
    this.composing = false;
    this.mouseDown = false;
    this.root = this.scroll.domNode;
    this.cursor = Parchment.create('cursor', this);
    // savedRange is last non-null range
    this.lastRange = this.savedRange = new Range(0, 0);
    this.handleComposition();
    this.handleDragging();
    this.emitter.listenDOM('selectionchange', document, () => {
      if (!this.mouseDown) {
        setTimeout(this.update.bind(this, Emitter.sources.USER), 1);
      }
    });
    this.emitter.on(Emitter.events.EDITOR_CHANGE, (type, delta) => {
      if (type === Emitter.events.TEXT_CHANGE && delta.length() > 0) {
        this.update(Emitter.sources.SILENT);
      }
    });
    this.emitter.on(Emitter.events.SCROLL_BEFORE_UPDATE, () => {
      if (!this.hasFocus()) return;
      let native = this.getNativeRange();
      if (native == null) return;
      if (native.start.node === this.cursor.textNode) return;  // cursor.restore() will handle
      // TODO unclear if this has negative side effects
      this.emitter.once(Emitter.events.SCROLL_UPDATE, () => {
        try {
          this.setNativeRange(native.start.node, native.start.offset, native.end.node, native.end.offset);
        } catch (ignored) {}
      });
    });
    this.emitter.on(Emitter.events.SCROLL_OPTIMIZE, (mutations, context) => {
      if (context.range) {
        const { startNode, startOffset, endNode, endOffset } = context.range;
        this.setNativeRange(startNode, startOffset, endNode, endOffset);
      }
    });
    this.update(Emitter.sources.SILENT);
  }

  handleComposition() {
    this.root.addEventListener('compositionstart', () => {
      this.composing = true;
    });
    this.root.addEventListener('compositionend', () => {
      this.composing = false;
      if (this.cursor.parent) {
        const range = this.cursor.restore();
        if (!range) return;
        setTimeout(() => {
          this.setNativeRange(range.startNode, range.startOffset, range.endNode, range.endOffset);
        }, 1);
      }
    });
  }

  handleDragging() {
    this.emitter.listenDOM('mousedown', document.body, () => {
      this.mouseDown = true;
    });
    this.emitter.listenDOM('mouseup', document.body, () => {
      this.mouseDown = false;
      this.update(Emitter.sources.USER);
    });
  }

  focus() {
    if (this.hasFocus()) return;
    this.root.focus();
    this.setRange(this.savedRange);
  }

  format(format, value) {
    if (this.scroll.whitelist != null && !this.scroll.whitelist[format]) return;
    this.scroll.update();
    let nativeRange = this.getNativeRange();
    if (nativeRange == null || !nativeRange.native.collapsed || Parchment.query(format, Parchment.Scope.BLOCK)) return;
    if (nativeRange.start.node !== this.cursor.textNode) {
      let blot = Parchment.find(nativeRange.start.node, false);
      if (blot == null) return;
      // TODO Give blot ability to not split
      if (blot instanceof Parchment.Leaf) {
        let after = blot.split(nativeRange.start.offset);
        blot.parent.insertBefore(this.cursor, after);
      } else {
        blot.insertBefore(this.cursor, nativeRange.start.node);  // Should never happen
      }
      this.cursor.attach();
    }
    this.cursor.format(format, value);
    this.scroll.optimize();
    this.setNativeRange(this.cursor.textNode, this.cursor.textNode.data.length);
    this.update();
  }

  getBounds(index, length = 0) {
    let scrollLength = this.scroll.length();
    index = Math.min(index, scrollLength - 1);
    length = Math.min(index + length, scrollLength - 1) - index;
    let node, [leaf, offset] = this.scroll.leaf(index);
    if (leaf == null) return null;
    [node, offset] = leaf.position(offset, true);
    let range = document.createRange();
    if (length > 0) {
      range.setStart(node, offset);
      [leaf, offset] = this.scroll.leaf(index + length);
      if (leaf == null) return null;
      [node, offset] = leaf.position(offset, true);
      range.setEnd(node, offset);
      return range.getBoundingClientRect();
    } else {
      let side = 'left';
      let rect;
      if (node instanceof Text) {
        if (offset < node.data.length) {
          range.setStart(node, offset);
          range.setEnd(node, offset + 1);
        } else {
          range.setStart(node, offset - 1);
          range.setEnd(node, offset);
          side = 'right';
        }
        rect = range.getBoundingClientRect();
      } else {
        rect = leaf.domNode.getBoundingClientRect();
        if (offset > 0) side = 'right';
      }
      return {
        bottom: rect.top + rect.height,
        height: rect.height,
        left: rect[side],
        right: rect[side],
        top: rect.top,
        width: 0
      };
    }
  }

  getNativeRange() {
    let selection = document.getSelection();
    console.groupCollapsed('getNativeRange()');
    console.log('selection: ', selection);

    if (selection == null || selection.rangeCount <= 0) {
      console.log('selection == null || selction.rangeCount <= 0, returning null');
      console.groupEnd();

      return null;
    }
    let nativeRange = selection.getRangeAt(0);
    if (nativeRange == null) {
      console.log('nativeRange == null, returning null');
      console.groupEnd();

      return null;
    }
    let range = this.normalizeNative(nativeRange);
    debug.info('getNativeRange', range);
    console.log('returning normalizeNative result: ', range);
    console.log('returning normalizeNative result, start: ', range && range.start);
    console.log('returning normalizeNative result, end: ', range && range.end);
    console.groupEnd();
    return range;
  }

  getRange() {
    let normalized = this.getNativeRange();
    if (normalized == null) return [null, null];
    let range = this.normalizedToRange(normalized);
    return [range, normalized];
  }

  hasFocus() {
    return document.activeElement === this.root || contains(this.root, document.activeElement);
  }

  normalizedToRange(range) {
    console.groupCollapsed('normalizedToRange()');

    let positions = [[range.start.node, range.start.offset]];
    if (!range.native.collapsed) {
      positions.push([range.end.node, range.end.offset]);
    }
    console.log('positions: ', positions);
    let indexes = positions.map((position, i) => {
      console.groupCollapsed(`positions.map, iteration ${i}`);
      let [node, offset] = position;
      console.log('node: ', node);
      let blot = Parchment.find(node, true);
      console.log('blot: ', blot);
      let index = blot.offset(this.scroll);
      console.log('index: ', index);

      if (blot instanceof Parchment.Leaf) {
        console.log('blot instanceof Parchment.Leaf, returning index + blot.index(node, offset): ', index + blot.index(node, offset));
        console.groupEnd();
        return index + blot.index(node, offset);
      }

      if (offset === 0) {
        console.log('offset === 0, returning `index`: ', index);
        console.groupEnd();
        return index;
      } else if (blot instanceof Parchment.Container) {
        console.log('blot instanceof Parchment.Container, returning `index + blot.length()`: ', index + blot.length());
        console.groupEnd();
        return index + blot.length();
      } else {
        console.log('else, returning `index + blot.index(node, offset)`: ', index + blot.index(node, offset));
        console.groupEnd();
        return index + blot.index(node, offset);
      }
    });
    let end = Math.min(Math.max(...indexes), this.scroll.length() - 1);
    let start = Math.min(end, ...indexes);

    console.log('end: ', end);
    console.log('start: ', start);
    console.groupEnd();
    return new Range(start, end-start);
  }

  normalizeNative(nativeRange) {
    console.groupCollapsed('Selection#normalizeNative()');
    console.log('args, nativeRange: ', nativeRange);
    console.log('args, nativeRange.startContainer: ', nativeRange.startContainer);
    console.groupCollapsed('trace');
    console.trace();
    console.groupEnd();
    console.groupEnd();
    if (!contains(this.root, nativeRange.startContainer) ||
        (!nativeRange.collapsed && !contains(this.root, nativeRange.endContainer))) {
      return null;
    }
    let range = {
      start: { node: nativeRange.startContainer, offset: nativeRange.startOffset },
      end: { node: nativeRange.endContainer, offset: nativeRange.endOffset },
      native: nativeRange
    };
    [range.start, range.end].forEach(function(position) {
      let node = position.node, offset = position.offset;
      while (!(node instanceof Text) && node.childNodes.length > 0) {
        if (node.childNodes.length > offset) {
          node = node.childNodes[offset];
          offset = 0;
        } else if (node.childNodes.length === offset) {
          node = node.lastChild;
          offset = node instanceof Text ? node.data.length : node.childNodes.length + 1;
        } else {
          break;
        }
      }
      position.node = node, position.offset = offset;
    });
    return range;
  }

  rangeToNative(range) {
    let indexes = range.collapsed ? [range.index] : [range.index, range.index + range.length];
    let args = [];
    let scrollLength = this.scroll.length();
    console.groupCollapsed('Selection#rangeToNative()');
    indexes.forEach((index, i) => {
      index = Math.min(scrollLength - 1, index);
      let node, [leaf, offset] = this.scroll.leaf(index);
      console.groupCollapsed(`##indexes.forEach, iter ${i}`);
      console.log('leaf: ', leaf);
      console.log('offset: ', offset);
      console.log('i !== 0: ', i !== 0);
      console.groupEnd();
      [node, offset] = leaf.position(offset, i !== 0);
      args.push(node, offset);
    });
    if (args.length < 2) {
      args = args.concat(args);
    }
    console.log('returning args: ', args);
    console.groupEnd();
    return args;
  }

  scrollIntoView(scrollingContainer) {
    let range = this.lastRange;
    if (range == null) return;
    let bounds = this.getBounds(range.index, range.length);
    if (bounds == null) return;
    let limit = this.scroll.length()-1;
    let [first, ] = this.scroll.line(Math.min(range.index, limit));
    let last = first;
    if (range.length > 0) {
      [last, ] = this.scroll.line(Math.min(range.index + range.length, limit));
    }
    if (first == null || last == null) return;
    let scrollBounds = scrollingContainer.getBoundingClientRect();
    if (bounds.top < scrollBounds.top) {
      scrollingContainer.scrollTop -= (scrollBounds.top - bounds.top);
    } else if (bounds.bottom > scrollBounds.bottom) {
      scrollingContainer.scrollTop += (bounds.bottom - scrollBounds.bottom);
    }
  }

  setNativeRange(startNode, startOffset, endNode = startNode, endOffset = startOffset, force = false) {
    debug.info('setNativeRange', startNode, startOffset, endNode, endOffset);
    if (startNode != null && (this.root.parentNode == null || startNode.parentNode == null || endNode.parentNode == null)) {
      return;
    }
    console.groupCollapsed('Selection#setNativeRange()');
    let selection = document.getSelection();
    if (selection == null) {
      console.groupEnd();
      return;
    }
    if (startNode != null) {
      if (!this.hasFocus()) this.root.focus();
      let native = (this.getNativeRange() || {}).native;
      console.log('native: ', native);
      if (native == null || force ||
        startNode !== native.startContainer ||
        startOffset !== native.startOffset ||
        endNode !== native.endContainer ||
        endOffset !== native.endOffset) {
        console.log('startNode: ', startNode);

        if (startNode.tagName == "BR") {
          startOffset = [].indexOf.call(startNode.parentNode.childNodes, startNode);
          startNode = startNode.parentNode;
        }
        if (endNode.tagName == "BR") {
          endOffset = [].indexOf.call(endNode.parentNode.childNodes, endNode);
          endNode = endNode.parentNode;
        }
        let range = document.createRange();
        range.setStart(startNode, startOffset);
        range.setEnd(endNode, endOffset);
        console.log('new range to set: ', range);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    } else {
      selection.removeAllRanges();
      this.root.blur();
      document.body.focus();  // root.blur() not enough on IE11+Travis+SauceLabs (but not local VMs)
    }
    console.groupEnd();
  }

  setRange(range, force = false, source = Emitter.sources.API) {
    if (typeof force === 'string') {
      source = force;
      force = false;
    }
    debug.info('setRange', range);
    if (range != null) {
      let args = this.rangeToNative(range);
      this.setNativeRange(...args, force);
    } else {
      this.setNativeRange(null);
    }
    this.update(source);
  }

  update(source = Emitter.sources.USER) {
    let oldRange = this.lastRange;
    console.groupCollapsed('[QUILL]Selection#update()');
    console.log('old range: ', oldRange);

    console.groupCollapsed('trace');
    console.trace();
    console.groupEnd();

    let [lastRange, nativeRange] = this.getRange();
    this.lastRange = lastRange;

    console.log('lastRange: ', lastRange);
    console.log('nativeRange: ', nativeRange);

    if (this.lastRange != null) {
      this.savedRange = this.lastRange;
    }
    if (!equal(oldRange, this.lastRange)) {
      console.log('oldRange !== this.lastRange');
      if (!this.composing && nativeRange != null && nativeRange.native.collapsed && nativeRange.start.node !== this.cursor.textNode) {
        console.log('first truthy check? about to call this.cursor.restore()');
        console.groupEnd();
        this.cursor.restore();
      }
      let args = [Emitter.events.SELECTION_CHANGE, clone(this.lastRange), clone(oldRange), source];
      this.emitter.emit(Emitter.events.EDITOR_CHANGE, ...args);
      if (source !== Emitter.sources.SILENT) {
        console.log('second truthy check? about to call emit()');
        console.groupEnd();

        this.emitter.emit(...args);
      }
    }
    console.groupEnd();
  }
}


function contains(parent, descendant) {
  try {
    // Firefox inserts inaccessible nodes around video elements
    descendant.parentNode;
  } catch (e) {
    return false;
  }
  // IE11 has bug with Text nodes
  // https://connect.microsoft.com/IE/feedback/details/780874/node-contains-is-incorrect
  if (descendant instanceof Text) {
    descendant = descendant.parentNode;
  }
  return parent.contains(descendant);
}


export { Range, Selection as default };
