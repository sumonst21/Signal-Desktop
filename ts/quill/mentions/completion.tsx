// Copyright 2020-2022 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import _ from 'lodash';
import type Quill from 'quill';
import Delta from 'quill-delta';
import type { RefObject } from 'react';
import React from 'react';

import { Popper } from 'react-popper';
import classNames from 'classnames';
import { createPortal } from 'react-dom';
import type { ConversationType } from '../../state/ducks/conversations';
import { Avatar } from '../../components/Avatar';
import type { LocalizerType, ThemeType } from '../../types/Util';
import type { MemberRepository } from '../memberRepository';
import type { PreferredBadgeSelectorType } from '../../state/selectors/badges';
import { matchBlotTextPartitions } from '../util';
import { handleOutsideClick } from '../../util/handleOutsideClick';
import { sameWidthModifier } from '../../util/popperUtil';

export type MentionCompletionOptions = {
  getPreferredBadge: PreferredBadgeSelectorType;
  i18n: LocalizerType;
  memberRepositoryRef: RefObject<MemberRepository>;
  setMentionPickerElement: (element: JSX.Element | null) => void;
  me?: ConversationType;
  theme: ThemeType;
};

const MENTION_REGEX = /(?:^|\W)@([-+\w]*)$/;

export class MentionCompletion {
  results: Array<ConversationType>;

  index: number;

  root: HTMLDivElement;

  quill: Quill;

  options: MentionCompletionOptions;

  suggestionListRef: RefObject<HTMLDivElement>;

  outsideClickDestructor: () => void;

  constructor(quill: Quill, options: MentionCompletionOptions) {
    this.results = [];
    this.index = 0;
    this.options = options;
    this.root = document.body.appendChild(document.createElement('div'));
    this.quill = quill;
    this.suggestionListRef = React.createRef<HTMLDivElement>();

    // Just to make sure that we don't propagate outside clicks until this
    // is closed.
    this.outsideClickDestructor = handleOutsideClick(
      () => {
        return true;
      },
      {
        name: 'quill.emoji.completion',
        containerElements: [this.root],
      }
    );

    const clearResults = () => {
      if (this.results.length) {
        this.clearResults();
      }

      return true;
    };

    const changeIndex = (by: number) => (): boolean => {
      if (this.results.length) {
        this.changeIndex(by);
        return false;
      }

      return true;
    };

    this.quill.keyboard.addBinding({ key: 37 }, clearResults); // Left Arrow
    this.quill.keyboard.addBinding({ key: 38 }, changeIndex(-1)); // Up Arrow
    this.quill.keyboard.addBinding({ key: 39 }, clearResults); // Right Arrow
    this.quill.keyboard.addBinding({ key: 40 }, changeIndex(1)); // Down Arrow

    this.quill.on('text-change', _.debounce(this.onTextChange.bind(this), 0));
    this.quill.on('selection-change', this.onSelectionChange.bind(this));
  }

  destroy(): void {
    this.outsideClickDestructor();
    this.root.remove();
  }

  changeIndex(by: number): void {
    this.index = (this.index + by + this.results.length) % this.results.length;
    this.render();
    const suggestionList = this.suggestionListRef.current;
    if (suggestionList) {
      const selectedElement = suggestionList.querySelector<HTMLElement>(
        '[aria-selected="true"]'
      );
      if (selectedElement) {
        selectedElement.scrollIntoViewIfNeeded(false);
      }
    }
  }

  onSelectionChange(): void {
    // Selection should never change while we're editing a mention
    this.clearResults();
  }

  possiblyShowMemberResults(): Array<ConversationType> {
    const range = this.quill.getSelection();

    if (range) {
      const [blot, index] = this.quill.getLeaf(range.index);

      const [leftTokenTextMatch] = matchBlotTextPartitions(
        blot,
        index,
        MENTION_REGEX
      );

      if (leftTokenTextMatch) {
        const [, leftTokenText] = leftTokenTextMatch;

        let results: Array<ConversationType> = [];

        const memberRepository = this.options.memberRepositoryRef.current;

        if (memberRepository) {
          if (leftTokenText === '') {
            results = memberRepository.getMembers(this.options.me);
          } else {
            const fullMentionText = leftTokenText;
            results = memberRepository.search(fullMentionText, this.options.me);
          }
        }

        return results;
      }
    }

    return [];
  }

  onTextChange(): void {
    const showMemberResults = this.possiblyShowMemberResults();

    if (showMemberResults.length > 0) {
      this.results = showMemberResults;
      this.index = 0;
      this.render();
    } else if (this.results.length !== 0) {
      this.clearResults();
    }
  }

  completeMention(resultIndexArg?: number): void {
    const resultIndex = resultIndexArg || this.index;

    const range = this.quill.getSelection();

    if (range == null) {
      return;
    }

    const member = this.results[resultIndex];

    const [blot, index] = this.quill.getLeaf(range.index);

    const [leftTokenTextMatch] = matchBlotTextPartitions(
      blot,
      index,
      MENTION_REGEX
    );

    if (leftTokenTextMatch) {
      const [, leftTokenText] = leftTokenTextMatch;

      this.insertMention(
        member,
        range.index - leftTokenText.length - 1,
        leftTokenText.length + 1,
        true
      );
    }
  }

  insertMention(
    mention: ConversationType,
    index: number,
    range: number,
    withTrailingSpace = false
  ): void {
    const delta = new Delta().retain(index).delete(range).insert({ mention });

    if (withTrailingSpace) {
      this.quill.updateContents(delta.insert(' '), 'user');
      this.quill.setSelection(index + 2, 0, 'user');
    } else {
      this.quill.updateContents(delta, 'user');
      this.quill.setSelection(index + 1, 0, 'user');
    }

    this.clearResults();
  }

  clearResults(): void {
    this.results = [];
    this.index = 0;

    this.render();
  }

  onUnmount(): void {
    document.body.removeChild(this.root);
  }

  render(): void {
    const { results: memberResults, index: memberResultsIndex } = this;
    const { getPreferredBadge, theme } = this.options;

    if (memberResults.length === 0) {
      this.options.setMentionPickerElement(null);
      return;
    }

    const element = createPortal(
      <Popper placement="top-start" modifiers={[sameWidthModifier]}>
        {({ ref, style }) => (
          <div
            ref={ref}
            className="module-composition-input__suggestions"
            style={style}
            role="listbox"
            aria-expanded
            aria-activedescendant={`mention-result--${
              memberResults.length ? memberResults[memberResultsIndex].name : ''
            }`}
            tabIndex={0}
          >
            <div
              ref={this.suggestionListRef}
              className="module-composition-input__suggestions--scroller"
            >
              {memberResults.map((member, index) => (
                <button
                  type="button"
                  key={member.uuid}
                  id={`mention-result--${member.name}`}
                  role="option button"
                  aria-selected={memberResultsIndex === index}
                  onClick={() => {
                    this.completeMention(index);
                  }}
                  className={classNames(
                    'module-composition-input__suggestions__row',
                    'module-composition-input__suggestions__row--mention',
                    memberResultsIndex === index
                      ? 'module-composition-input__suggestions__row--selected'
                      : null
                  )}
                >
                  <Avatar
                    acceptedMessageRequest={member.acceptedMessageRequest}
                    avatarPath={member.avatarPath}
                    badge={getPreferredBadge(member.badges)}
                    conversationType="direct"
                    i18n={this.options.i18n}
                    isMe={member.isMe}
                    sharedGroupNames={member.sharedGroupNames}
                    size={28}
                    theme={theme}
                    title={member.title}
                    unblurredAvatarPath={member.unblurredAvatarPath}
                  />
                  <div className="module-composition-input__suggestions__title">
                    {member.title}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </Popper>,
      this.root
    );

    this.options.setMentionPickerElement(element);
  }
}
