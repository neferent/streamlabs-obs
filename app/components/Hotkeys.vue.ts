import Vue from 'vue';
import { Component } from 'vue-property-decorator';
import { Inject } from 'services';
import { HotkeysService, IHotkeysSet, IHotkey } from 'services/hotkeys';
import { ScenesService } from '../services/scenes';
import { SourcesService } from '../services/sources';
import HotkeyGroup from './HotkeyGroup';
import VFormGroup from 'components/shared/inputs/VFormGroup.vue';
import Fuse from 'fuse.js';
import mapValues from 'lodash/mapValues';

interface IAugmentedHotkey extends IHotkey {
  // Will be scene or source name
  categoryName?: string;
}

interface IAugmentedHotkeySet {
  general: IAugmentedHotkey[];
  sources: Dictionary<IAugmentedHotkey[]>;
  scenes: Dictionary<IAugmentedHotkey[]>;
}

@Component({
  components: { HotkeyGroup, VFormGroup },
})
export default class Hotkeys extends Vue {
  @Inject() private sourcesService: SourcesService;
  @Inject() private scenesService: ScenesService;
  @Inject() private hotkeysService: HotkeysService;

  hotkeySet: IHotkeysSet = null;

  searchString = '';

  mounted() {
    // We don't want hotkeys registering while trying to bind.
    // We may change our minds on this in the future.
    this.hotkeysService.unregisterAll();

    // Render a blank page before doing synchronous IPC
    setTimeout(() => (this.hotkeySet = this.hotkeysService.getHotkeysSet()), 100);
  }

  destroyed() {
    this.hotkeysService.applyHotkeySet(this.hotkeySet);
  }

  get sources() {
    return this.sourcesService.sources;
  }

  get augmentedHotkeySet(): IAugmentedHotkeySet {
    return {
      general: this.hotkeySet.general,
      sources: mapValues(this.hotkeySet.sources, (hotkeys, sourceId) => {
        return hotkeys.map((hotkey: IAugmentedHotkey) => {
          // Mutating the original object is required for bindings to work
          // TODO: We should refactor this to not rely on child components
          // mutating the original objects.
          hotkey.categoryName = this.sourcesService.getSource(sourceId).name;
          return hotkey;
        });
      }),
      scenes: mapValues(this.hotkeySet.scenes, (hotkeys, sceneId) => {
        return hotkeys.map((hotkey: IAugmentedHotkey) => {
          hotkey.categoryName = this.scenesService.getScene(sceneId).name;
          return hotkey;
        });
      }),
    };
  }

  get filteredHotkeySet(): IAugmentedHotkeySet {
    if (this.searchString) {
      return {
        general: this.filterHotkeys(this.augmentedHotkeySet.general),
        sources: mapValues(this.augmentedHotkeySet.sources, hotkeys => this.filterHotkeys(hotkeys)),
        scenes: mapValues(this.augmentedHotkeySet.scenes, hotkeys => this.filterHotkeys(hotkeys)),
      };
    }

    return this.augmentedHotkeySet;
  }

  private filterHotkeys(hotkeys: IHotkey[]): IHotkey[] {
    return new Fuse(hotkeys, {
      keys: ['description', 'categoryName'],
      threshold: 0.4,
      shouldSort: true,
    }).search(this.searchString);
  }
}
