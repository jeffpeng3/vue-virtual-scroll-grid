import {
  combineLatest,
  debounceTime,
  distinct,
  distinctUntilChanged,
  filter,
  map,
  merge,
  mergeAll,
  mergeMap,
  Observable,
  of,
  range,
  scan,
  shareReplay,
  switchMap,
  take,
} from "rxjs";
import {
  __,
  addIndex,
  apply,
  complement,
  concat,
  difference,
  equals,
  identity,
  insertAll,
  isNil,
  map as ramdaMap,
  pipe,
  remove,
  slice,
  without,
  zip,
} from "ramda";
import { getVerticalScrollParent } from "./utilites";

export function computeHeightAboveWindowOf(el: Element): number {
  const top = el.getBoundingClientRect().top;

  return Math.abs(Math.min(top, 0));
}

interface GridMeasurement {
  colGap: number;
  rowGap: number;
  columns: number;
}

export function getGridMeasurement(rootEl: Element): GridMeasurement {
  const computedStyle = window.getComputedStyle(rootEl);

  return {
    rowGap: parseInt(computedStyle.getPropertyValue("row-gap")) || 0,
    colGap: parseInt(computedStyle.getPropertyValue("column-gap")) || 0,
    columns: computedStyle.getPropertyValue("grid-template-columns").split(" ")
      .length,
  };
}

interface ResizeMeasurement {
  rowGap: number;
  columns: number;
  itemHeightWithGap: number;
  itemWidthWithGap: number;
}

export function getResizeMeasurement(
  rootEl: Element,
  { height, width }: DOMRectReadOnly
): ResizeMeasurement {
  const { rowGap, colGap, columns } = getGridMeasurement(rootEl);

  return {
    rowGap,
    columns,
    itemHeightWithGap: height + rowGap,
    itemWidthWithGap: width + colGap,
  };
}

interface BufferMeta {
  bufferedOffset: number;
  bufferedLength: number;
}

export const getBufferMeta =
  (windowInnerHeight: number = window.innerHeight) =>
  (
    heightAboveWindow: number,
    { columns, rowGap, itemHeightWithGap }: ResizeMeasurement
  ): BufferMeta => {
    const rowsInView =
      itemHeightWithGap &&
      Math.ceil((windowInnerHeight + rowGap) / itemHeightWithGap) + 1;
    const length = rowsInView * columns;

    const rowsBeforeView =
      itemHeightWithGap &&
      Math.floor((heightAboveWindow + rowGap) / itemHeightWithGap);
    const offset = rowsBeforeView * columns;
    const bufferedOffset = Math.max(offset - Math.floor(length / 2), 0);
    const bufferedLength = length * 2;

    return {
      bufferedOffset,
      bufferedLength,
    };
  };

export function getObservableOfVisiblePageNumbers(
  { bufferedOffset, bufferedLength }: BufferMeta,
  length: number,
  pageSize: number
): Observable<number> {
  const startPage = Math.floor(bufferedOffset / pageSize);
  const endPage = Math.ceil(
    Math.min(bufferedOffset + bufferedLength, length) / pageSize
  );
  const numberOfPages = endPage - startPage;

  return range(startPage, numberOfPages);
}

interface ItemsByPage {
  pageNumber: number;
  items: unknown[];
}

export type PageProvider = (
  pageNumber: number,
  pageSize: number
) => Promise<unknown[]>;

export function callPageProvider(
  pageNumber: number,
  pageSize: number,
  pageProvider: PageProvider
): Promise<ItemsByPage> {
  return pageProvider(pageNumber, pageSize).then((items) => ({
    pageNumber,
    items,
  }));
}

export function accumulateAllItems(
  allItems: unknown[],
  [{ pageNumber, items }, length, pageSize]: [ItemsByPage, number, number]
): unknown[] {
  const allItemsFill = new Array(Math.max(length - allItems.length, 0)).fill(
    undefined
  );

  const pageFill = new Array(Math.max(pageSize - items.length, 0)).fill(
    undefined
  );

  const normalizedItems = concat(slice(0, pageSize, items), pageFill);

  return pipe<unknown[][], unknown[], unknown[], unknown[], unknown[]>(
    concat(__, allItemsFill),
    remove(pageNumber * pageSize, pageSize),
    insertAll(pageNumber * pageSize, normalizedItems),
    slice(0, length)
  )(allItems);
}

export interface InternalItem {
  index: number;
  value: unknown | undefined;
  style?: { transform: string; gridArea: string };
}

export function getVisibleItems(
  { bufferedOffset, bufferedLength }: BufferMeta,
  { columns, itemWidthWithGap, itemHeightWithGap }: ResizeMeasurement,
  allItems: unknown[]
): InternalItem[] {
  return pipe<unknown[][], unknown[], InternalItem[]>(
    slice(bufferedOffset, bufferedOffset + bufferedLength),
    addIndex(ramdaMap)((value, localIndex) => {
      const index = bufferedOffset + localIndex;
      const x = (index % columns) * itemWidthWithGap;
      const y = Math.floor(index / columns) * itemHeightWithGap;

      return {
        index,
        value,
        style: {
          gridArea: "1/1",
          transform: `translate(${x}px, ${y}px)`,
        },
      };
    }) as (a: unknown[]) => InternalItem[]
  )(allItems);
}

export function accumulateBuffer(
  buffer: InternalItem[],
  visibleItems: InternalItem[]
): InternalItem[] {
  const itemsToAdd = difference(visibleItems, buffer);
  const itemsFreeToUse = difference(buffer, visibleItems);

  const replaceMap = new Map(zip(itemsFreeToUse, itemsToAdd));
  const itemsToBeReplaced = [...replaceMap.keys()];
  const itemsToReplaceWith = [...replaceMap.values()];

  const itemsToDelete = difference(itemsFreeToUse, itemsToBeReplaced);
  const itemsToAppend = difference(itemsToAdd, itemsToReplaceWith);

  return pipe(
    without(itemsToDelete),
    ramdaMap((item) => replaceMap.get(item) ?? item),
    concat(__, itemsToAppend)
  )(buffer);
}

export function getContentHeight(
  { columns, rowGap, itemHeightWithGap }: ResizeMeasurement,
  length: number
): number {
  return itemHeightWithGap * Math.ceil(length / columns) - rowGap;
}

interface PipelineInput {
  length$: Observable<number>;
  pageProvider$: Observable<PageProvider>;
  pageProviderDebounceTime$: Observable<number>;
  pageSize$: Observable<number>;
  itemRect$: Observable<DOMRectReadOnly>;
  rootResize$: Observable<Element>;
  scroll$: Observable<Element>;
  scrollTo$: Observable<number | undefined>;
}

export type ScrollAction = [Element, number];

interface PipelineOutput {
  buffer$: Observable<InternalItem[]>;
  contentHeight$: Observable<number>;
  scrollAction$: Observable<ScrollAction>;
}

export function pipeline({
  length$,
  pageProvider$,
  pageProviderDebounceTime$,
  pageSize$,
  itemRect$,
  rootResize$,
  scroll$,
  scrollTo$,
}: PipelineInput): PipelineOutput {
  // region: measurements of the visual grid
  const heightAboveWindow$: Observable<number> = merge(
    rootResize$,
    scroll$
  ).pipe(map(computeHeightAboveWindowOf), distinctUntilChanged());

  const resizeMeasurement$: Observable<ResizeMeasurement> = combineLatest(
    [rootResize$, itemRect$],
    getResizeMeasurement
  ).pipe(distinctUntilChanged<ResizeMeasurement>(equals));

  const contentHeight$: Observable<number> = combineLatest(
    [resizeMeasurement$, length$],
    getContentHeight
  );
  // endregion

  // region: scroll to a given item by index
  const scrollAction$: Observable<ScrollAction> = scrollTo$.pipe(
    filter(complement(isNil)),
    switchMap<number, Observable<[number, ResizeMeasurement, Element]>>(
      (scrollTo) =>
        combineLatest([of(scrollTo), resizeMeasurement$, rootResize$]).pipe(
          take(1)
        )
    ),
    map<[number, ResizeMeasurement, Element], ScrollAction>(
      ([scrollTo, { columns, itemHeightWithGap }, rootEl]) => {
        const verticalScrollEl = getVerticalScrollParent(rootEl);

        const computedStyle = window.getComputedStyle(rootEl);

        const gridPaddingTop = parseInt(
          computedStyle.getPropertyValue("padding-top")
        );
        const gridBoarderTop = parseInt(
          computedStyle.getPropertyValue("border-top")
        );

        const topToGridContainer =
          rootEl instanceof HTMLElement &&
          verticalScrollEl instanceof HTMLElement
            ? rootEl.offsetTop - verticalScrollEl.offsetTop
            : 0;

        // The offset within the scroll container
        const scrollTop =
          // row count * row height
          Math.floor(scrollTo / columns) * itemHeightWithGap +
          // top to the scroll container
          topToGridContainer +
          // the padding + boarder top of grid
          gridPaddingTop +
          gridBoarderTop;
        return [verticalScrollEl, scrollTop];
      }
    )
  );
  // endregion

  // region: rendering buffer
  const bufferMeta$: Observable<BufferMeta> = combineLatest(
    [heightAboveWindow$, resizeMeasurement$],
    getBufferMeta()
  ).pipe(distinctUntilChanged<BufferMeta>(equals));

  const visiblePageNumbers$ = combineLatest([
    bufferMeta$,
    length$,
    pageSize$,
  ]).pipe(map(apply(getObservableOfVisiblePageNumbers)));

  const pageNumber$ = pageProviderDebounceTime$.pipe(
    switchMap((time) =>
      visiblePageNumbers$.pipe(time === 0 ? identity : debounceTime(time))
    ),
    mergeAll(),
    distinct(identity, merge(pageSize$, pageProvider$))
  );

  const itemsByPage$: Observable<ItemsByPage> = combineLatest([
    pageNumber$,
    pageSize$,
    pageProvider$,
  ]).pipe(mergeMap(apply(callPageProvider)), shareReplay(1));

  const replayLength$ = length$.pipe(shareReplay(1));

  const allItems$: Observable<unknown[]> = pageProvider$.pipe(
    switchMap(() => combineLatest([itemsByPage$, replayLength$, pageSize$])),
    scan(accumulateAllItems, [])
  );

  const buffer$: Observable<InternalItem[]> = combineLatest(
    [bufferMeta$, resizeMeasurement$, allItems$],
    getVisibleItems
  ).pipe(scan(accumulateBuffer, []));
  // endregion

  return { buffer$, contentHeight$, scrollAction$: scrollAction$ };
}
