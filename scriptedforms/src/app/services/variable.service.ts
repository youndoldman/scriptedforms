// Scripted Forms -- Making GUIs easy for everyone on your team.
// Copyright (C) 2017 Simon Biggs

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version (the "AGPL-3.0+").

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License and the additional terms for more
// details.

// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <http://www.gnu.org/licenses/>.

// ADDITIONAL TERMS are also included as allowed by Section 7 of the GNU
// Affrero General Public License. These aditional terms are Sections 1, 5,
// 6, 7, 8, and 9 from the Apache License, Version 2.0 (the "Apache-2.0")
// where all references to the definition "License" are instead defined to
// mean the AGPL-3.0+.

// You should have received a copy of the Apache-2.0 along with this
// program. If not, see <http://www.apache.org/licenses/LICENSE-2.0>.

/*
This will eventually be how the variables are saved.

Not yet implemented.
*/

import { BehaviorSubject } from 'rxjs/BehaviorSubject';

import { Slot } from '@phosphor/signaling';
import { PromiseDelegate } from '@phosphor/coreutils';

import { Kernel, KernelMessage, Session } from '@jupyterlab/services';
import { nbformat } from '@jupyterlab/coreutils';

import * as  stringify from 'json-stable-stringify';
import * as uuid from 'uuid';

import { Injectable } from '@angular/core';
import { KernelService } from './kernel.service';

import { VariableStore } from '../interfaces/variable-store';
import { VariableValue } from '../types/variable-value';

import { VariableComponent } from '../types/variable-component';



export interface SessionVariableStore {
  [sessionId: string]: {
    variableStore: BehaviorSubject<VariableStore>;
    oldVariableStore: VariableStore;
    variableIdentifierMap: {
      [key: string]: string
    };
    variableEvaluateMap: {
      [key: string]: string
    };
    pythonVariables: VariableStore;
    variableChangedObservable: BehaviorSubject<VariableStore>;
    variableComponentStore: {
      [key: string]: VariableComponent
    };
    updateExecutionSlot: Slot<Session.ISession, KernelMessage.IIOPubMessage>
    executionCount: BehaviorSubject<nbformat.ExecutionCount>;
    lastCode: BehaviorSubject<string>;
  };
}


@Injectable()
export class VariableService {
  sessionVariableStore: SessionVariableStore = {};
  variableHandlerClass = '_VariableHandler';
  handlerName = '_scriptedforms_variable_handler';
  fetchVariablesCode = `exec(${this.handlerName}.fetch_code)`;
  variableStatus: BehaviorSubject<string> = new BehaviorSubject(null);

  constructor(
    private myKernelSevice: KernelService
  ) { }

  updateExecution(session: Session.ISession, msg: KernelMessage.IIOPubMessage) {
    if (KernelMessage.isExecuteInputMsg(msg)) {
      const executeInputMessage: KernelMessage.IExecuteInputMsg = msg;
      this.sessionVariableStore[session.id].executionCount.next(executeInputMessage.content.execution_count);
      this.sessionVariableStore[session.id].lastCode.next(executeInputMessage.content.code);
    }
  }

  variableInitialisation(sessionId: string) {
    if (!(sessionId in this.sessionVariableStore)) {
      this.sessionVariableStore[sessionId] = {
        variableStore: new BehaviorSubject({}),
        oldVariableStore: null,
        variableIdentifierMap: {},
        variableEvaluateMap: {},
        pythonVariables: {},
        variableChangedObservable: new BehaviorSubject(null),
        variableComponentStore: {},
        executionCount: new BehaviorSubject(null),
        lastCode: new BehaviorSubject(null),
        updateExecutionSlot: (session, msg) => {this.updateExecution(session, msg); }
      };

      this.sessionVariableStore[sessionId].lastCode.subscribe((code) => {
        if (code) {
          const commentRemovedCode = code.replace(/^#.*\n/, '');
          if (commentRemovedCode !== this.fetchVariablesCode) {
            this.fetchAll(sessionId);
          }
        }
      });
    }
  }

  startListeningForChanges(sessionId: string) {
    this.myKernelSevice.sessionStore[sessionId].session.iopubMessage.connect(
      this.sessionVariableStore[sessionId].updateExecutionSlot);
  }

  resetVariableService(sessionId: string) {
    this.variableStatus.next('reset');
    this.sessionVariableStore[sessionId].variableStore.next({});
    this.sessionVariableStore[sessionId].oldVariableStore = {};
    this.sessionVariableStore[sessionId].variableComponentStore = {};
    this.sessionVariableStore[sessionId].variableIdentifierMap = {};
    this.sessionVariableStore[sessionId].variableEvaluateMap = {};

    this.myKernelSevice.sessionStore[sessionId].session.iopubMessage.disconnect(
      this.sessionVariableStore[sessionId].updateExecutionSlot);
  }

  allVariablesInitilised(sessionId: string) {
    const initilisationComplete = new PromiseDelegate<void>();
    this.variableStatus.next('initialising');
    const jsonEvaluateMap = JSON.stringify(this.sessionVariableStore[sessionId].variableEvaluateMap);
    const initialiseHandlerCode = `${this.handlerName} = ${this.variableHandlerClass}("""${jsonEvaluateMap}""", "${this.handlerName}")`;
    this.myKernelSevice.runCode(sessionId, initialiseHandlerCode, '"initialiseVariableHandler"')
    .then((future: Kernel.IFuture) => {
      if (future) {
        future.done.then(() => {
          // This needs to have a different name than "fetchAllVariables" so that it
          // doesn't get clobbered. This particular fetch must always occur so that
          // the form can be declared ready.
          this.fetchAll(sessionId, '"InitialFetchAllVariables"').then(() => {
            this.startListeningForChanges(sessionId);
            initilisationComplete.resolve(null);
          });
        });
      } else {
        console.log('No future returned from initialiseVariableHandler');
      }
    });

    return initilisationComplete.promise;
  }

  appendToIdentifierMap(sessionId: string, variableIdentifier: string, variableName: string) {
    this.sessionVariableStore[sessionId].variableIdentifierMap[variableIdentifier] = variableName;
  }

  appendToEvaluateMap(sessionId: string, variableName: string, variableEvaluate: string) {
    if (!(variableName in this.sessionVariableStore[sessionId].variableEvaluateMap)) {
      this.sessionVariableStore[sessionId].variableEvaluateMap[variableName] = variableEvaluate;
    }
  }

  initialiseVariableComponent(sessionId: string, component: VariableComponent) {
    const variableIdentifier = component.variableIdentifier;
    this.sessionVariableStore[sessionId].variableComponentStore[variableIdentifier] = component;

    const variableEvaluate = component.pythonVariableEvaluate();
    const variableName = component.variableName;

    this.appendToIdentifierMap(sessionId, variableIdentifier, variableName);
    this.appendToEvaluateMap(sessionId, variableName, variableEvaluate);
  }

  convertToVariableStore(sessionId: string, textContent: string) {
    const result = JSON.parse(textContent);

    this.sessionVariableStore[sessionId].pythonVariables = result;

    const newVariableStore: VariableStore = {};
    Object.entries(this.sessionVariableStore[sessionId].variableIdentifierMap).forEach(
      ([variableIdentifier, variableName]) => {
        newVariableStore[variableIdentifier] = result[variableName];
      }
    );
    this.sessionVariableStore[sessionId].variableStore.next(newVariableStore);
  }

  ifJsonString(string: string) {
    try {
      JSON.parse(string);
    } catch (err) {
        return false;
    }
    return true;
  }

  fetchAll(sessionId: string, label = '"fetchAllVariables"') {
    this.variableStatus.next('fetching');

    const fetchComplete = new PromiseDelegate<void> ();
    this.myKernelSevice.runCode(
      sessionId, this.fetchVariablesCode, label)
    .then((future: Kernel.IFuture) => {
      if (future) {
        let textContent = '';
        future.onIOPub = (msg => {
          if (msg.content.text) {
            textContent = textContent.concat(String(msg.content.text));
            if (this.ifJsonString(textContent)) {
              this.convertToVariableStore(sessionId, textContent);
              this.checkForChanges(sessionId);
            }
          }
        });
        future.done.then(() => {
          fetchComplete.resolve(null);
        });
      }
    });

    return fetchComplete.promise;
  }

  updateComponentView(component: any, value: VariableValue) {
    component.updateVariableView(JSON.parse(JSON.stringify(value)));
  }

  variableHasChanged(sessionId: string, identifier: string) {
    this.updateComponentView(
      this.sessionVariableStore[sessionId].variableComponentStore[identifier],
      this.sessionVariableStore[sessionId].variableStore.getValue()[identifier].value);
  }

  checkForChanges(sessionId: string) {
    this.variableStatus.next('checking-for-changes');
    const variableIdentifiers = Object.keys(this.sessionVariableStore[sessionId].variableComponentStore);

    for (const identifier of variableIdentifiers) {
      if (this.sessionVariableStore[sessionId].variableStore.getValue()[identifier].defined) {
        if (this.sessionVariableStore[sessionId].oldVariableStore) {
          if (
            stringify(this.sessionVariableStore[sessionId].variableStore.getValue()[identifier]) !==
            stringify(this.sessionVariableStore[sessionId].oldVariableStore[identifier])
          ) {
            this.variableHasChanged(sessionId, identifier);
          }
        } else {
          this.variableHasChanged(sessionId, identifier);
        }
      }
    }
    const aVariableHasChanged = (
      stringify(this.sessionVariableStore[sessionId].variableStore.getValue()) !==
      stringify(this.sessionVariableStore[sessionId].oldVariableStore)
    );
    if (aVariableHasChanged) {
      this.sessionVariableStore[sessionId].variableChangedObservable.next(this.sessionVariableStore[sessionId].variableStore.getValue());
      this.variableStatus.next('a-change-was-made');
    } else {
      this.variableStatus.next('no-change-was-made');
    }

    const id = uuid.v4();
    const staticStatus = 'prepping-for-idle: ' + id;
    this.variableStatus.next(staticStatus);
    this.myKernelSevice.sessionStore[this.myKernelSevice.currentSession].queue.then(() => {
      if (this.variableStatus.getValue() === staticStatus) {
        this.variableStatus.next('idle');
      }
    });
    this.sessionVariableStore[sessionId].oldVariableStore = JSON.parse(
      JSON.stringify(this.sessionVariableStore[sessionId].variableStore.getValue())
    );
  }

  pushVariable(sessionId: string, variableIdentifier: string, variableName: string, valueReference: string) {
    const pushCode = `${variableName} = ${valueReference}`;

    this.sessionVariableStore[sessionId].oldVariableStore[variableIdentifier] = {
      defined: true,
      value: JSON.parse(JSON.stringify(valueReference))
    };

    return this.myKernelSevice.runCode(
      sessionId, pushCode, '"push"_"' + variableIdentifier + '"'
    ).then(future => {
      if (future) {
        const promise = future.done;
        return promise;
      } else {
        return Promise.resolve('ignore');
      }
    });
  }
}
